import "server-only";
import { db } from "@/server/db";
import { applyGhJobs, applyGhRun } from "./actions-events";
import {
  DeadlineReached,
  RateLimited,
  type Deadline,
  type RateBudget,
} from "./budget";
import type { RunRow } from "./fold";
import { errorStatus, type GitHubApi } from "./github-client";
import type { GhWorkflowJob, GhWorkflowRun } from "./github-map";
import { loadRepoContext, markJobsSynced, type RepoContext } from "./history";
import {
  createdQuery,
  nextBackfillWindow,
  planWindows,
  windowOf,
  type Window,
} from "./windows";

/**
 * Reconcile steps c) stale state, d) incremental sync and e) backfill
 * (design §5.3). Everything goes through the webhook fold functions, so a run
 * seen by webhook, sync and backfill converges to the same row. Each step
 * checks the deadline between units of work and persists its cursor in
 * SyncState, so the next tick resumes where this one stopped.
 */

const PER_PAGE = 100;
const MAX_PAGES = 10; // 1,000-result cap
const INCREMENTAL_OVERLAP_MS = 60 * 60 * 1000;
const RESYNC_WINDOW_MS = 3 * 86_400_000;
const STALE_JOB_MS = 30 * 60 * 1000;
const STALE_RUN_MS = 60 * 60 * 1000;
const LEAN_STALE_RUN_MS = 5 * 60 * 1000;
const HOSTED_JOB_LIMIT_MS = 6 * 60 * 60 * 1000;
const SELF_HOSTED_JOB_LIMIT_MS = 5 * 86_400_000;
const STALE_BATCH = 50;
/** Time a unit of work may still need; steps stop before the deadline. */
const RESERVE_MS = 5_000;

export type SyncRepo = {
  id: bigint;
  ownerLogin: string;
  name: string;
  fullName: string;
  defaultBranch: string;
};

export type SyncStats = {
  runs: number;
  jobs: number;
  requests: number;
  windows: number;
  notModified: number;
};

export type SyncContext = {
  installationId: bigint;
  api: GitHubApi;
  budget: RateBudget;
  deadline: Deadline;
  lean: boolean;
  /** Effective backfill depth: min(BACKFILL_DAYS, retention). */
  backfillDays: number;
  stats: SyncStats;
};

export function newStats(): SyncStats {
  return { runs: 0, jobs: 0, requests: 0, windows: 0, notModified: 0 };
}

function checkBudget(ctx: SyncContext, rateGuarded: boolean) {
  if (ctx.deadline.expired(RESERVE_MS)) throw new DeadlineReached();
  if (rateGuarded ? ctx.budget.paused() : ctx.budget.blocked())
    throw new RateLimited(ctx.budget.retryAt());
}

type RunsPage = { total_count: number; workflow_runs: GhWorkflowRun[] };

async function listRuns(
  ctx: SyncContext,
  repo: SyncRepo,
  params: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  ctx.stats.requests++;
  return ctx.api.request<RunsPage>("GET /repos/{owner}/{repo}/actions/runs", {
    owner: repo.ownerLogin,
    repo: repo.name,
    ...params,
    ...(headers ? { headers } : {}),
  });
}

async function listJobs(
  ctx: SyncContext,
  repo: SyncRepo,
  runId: bigint,
): Promise<GhWorkflowJob[]> {
  const jobs: GhWorkflowJob[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    ctx.stats.requests++;
    const res = await ctx.api.request<{
      total_count: number;
      jobs: GhWorkflowJob[];
    }>("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      owner: repo.ownerLogin,
      repo: repo.name,
      run_id: Number(runId),
      filter: "all",
      per_page: PER_PAGE,
      page,
    });
    jobs.push(...res.data.jobs);
    if (res.data.jobs.length < PER_PAGE || jobs.length >= res.data.total_count)
      break;
  }
  return jobs;
}

function needsJobs(row: RunRow): boolean {
  if (row.statusRank !== 4) return false;
  if (!row.jobsSyncedAt) return true;
  return (
    row.githubUpdatedAt != null &&
    row.githubUpdatedAt.getTime() > row.jobsSyncedAt.getTime()
  );
}

/** Folds REST runs, then their jobs and (for re-runs) attempt 1. */
export async function ingestRuns(
  ctx: SyncContext,
  repo: SyncRepo,
  runs: ReadonlyArray<GhWorkflowRun>,
  source: "BACKFILL" | "RECONCILE",
  repoCtx?: RepoContext,
  rateGuarded = true,
): Promise<void> {
  const c = repoCtx ?? (await loadRepoContext(ctx.installationId, repo.id));
  for (const run of runs) {
    checkBudget(ctx, rateGuarded);
    const now = new Date(ctx.deadline.now());
    let row = await applyGhRun(
      ctx.installationId,
      repo.id,
      run,
      repo.defaultBranch,
      now,
      source,
      c,
    );
    ctx.stats.runs++;
    if (
      row.statusRank === 4 &&
      row.runAttempt > 1 &&
      row.firstAttemptConclusion == null
    ) {
      ctx.stats.requests++;
      const first = await ctx.api.request<GhWorkflowRun>(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}",
        {
          owner: repo.ownerLogin,
          repo: repo.name,
          run_id: run.id,
          attempt_number: 1,
        },
      );
      row = await applyGhRun(
        ctx.installationId,
        repo.id,
        first.data,
        repo.defaultBranch,
        now,
        source,
        c,
      );
    }
    if (needsJobs(row)) {
      const jobs = await listJobs(ctx, repo, row.id);
      await applyGhJobs(ctx.installationId, repo.id, jobs, now, source, c);
      ctx.stats.jobs += jobs.length;
      await markJobsSynced(row.id, row.githubUpdatedAt ?? now);
    }
  }
}

/**
 * Ingests every run created inside `w`, splitting windows that reach
 * GitHub's 1,000-result cap. `onLeafDone` runs after each leaf (newest first)
 * so backfill can persist its progress.
 */
export async function syncWindow(
  ctx: SyncContext,
  repo: SyncRepo,
  w: Window,
  source: "BACKFILL" | "RECONCILE",
  onLeafDone?: (leaf: Window) => Promise<void>,
): Promise<void> {
  const repoCtx = await loadRepoContext(ctx.installationId, repo.id);
  const leaves = await planWindows(w, async (part) => {
    checkBudget(ctx, true);
    const res = await listRuns(ctx, repo, {
      created: createdQuery(part),
      per_page: 1,
    });
    return res.data.total_count;
  });
  for (const leaf of leaves) {
    ctx.stats.windows++;
    for (let page = 1; page <= MAX_PAGES; page++) {
      checkBudget(ctx, true);
      const res = await listRuns(ctx, repo, {
        created: createdQuery(leaf),
        per_page: PER_PAGE,
        page,
      });
      await ingestRuns(ctx, repo, res.data.workflow_runs, source, repoCtx);
      if (res.data.workflow_runs.length < PER_PAGE) break;
    }
    await onLeafDone?.(leaf);
  }
  if (leaves.length === 0) await onLeafDone?.(w);
}

async function syncState(repo: SyncRepo, installationId: bigint) {
  return db.syncState.upsert({
    where: { repositoryId: repo.id },
    create: { repositoryId: repo.id, installationId },
    update: {},
  });
}

const ETAG_SEPARATOR = "\n";

/**
 * d) Runs created since the cursor (minus one hour of overlap), with
 * If-None-Match so an unchanged list costs no rate limit. `needsResync`
 * widens the window to three days. The cursor is the newest created_at seen.
 */
export async function incrementalSync(
  ctx: SyncContext,
  repo: SyncRepo,
): Promise<void> {
  const state = await syncState(repo, ctx.installationId);
  const now = new Date(ctx.deadline.now());
  if (!state.runsCursor) {
    // A new repository: incremental sync starts now, backfill covers the past.
    await db.syncState.update({
      where: { repositoryId: repo.id },
      data: {
        runsCursor: now,
        backfillUntil: state.backfillUntil ?? now,
      },
    });
    state.runsCursor = now;
  }
  const since = state.needsResync
    ? new Date(now.getTime() - RESYNC_WINDOW_MS)
    : new Date(state.runsCursor.getTime() - INCREMENTAL_OVERLAP_MS);
  const created = `>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`;

  checkBudget(ctx, true);
  const [etagQuery, etag] = (state.runsEtag ?? "").split(ETAG_SEPARATOR);
  let first;
  try {
    first = await listRuns(
      ctx,
      repo,
      { created, per_page: PER_PAGE, page: 1 },
      etag && etagQuery === created ? { "if-none-match": etag } : undefined,
    );
  } catch (error) {
    if (errorStatus(error) === 304) {
      ctx.stats.notModified++;
      return;
    }
    throw error;
  }
  if (first.status === 304) {
    ctx.stats.notModified++;
    return;
  }

  let newest = state.runsCursor.getTime();
  const seen = (runs: GhWorkflowRun[]) => {
    for (const r of runs) newest = Math.max(newest, Date.parse(r.created_at));
  };

  if (first.data.total_count >= PER_PAGE * MAX_PAGES) {
    // A burst above the cap: fall back to split windows.
    await syncWindow(ctx, repo, windowOf(since, now), "RECONCILE");
    newest = Math.max(newest, now.getTime());
  } else {
    const repoCtx = await loadRepoContext(ctx.installationId, repo.id);
    await ingestRuns(ctx, repo, first.data.workflow_runs, "RECONCILE", repoCtx);
    seen(first.data.workflow_runs);
    let page = 1;
    let last = first.data.workflow_runs.length;
    while (last === PER_PAGE && page < MAX_PAGES) {
      page++;
      checkBudget(ctx, true);
      const res = await listRuns(ctx, repo, {
        created,
        per_page: PER_PAGE,
        page,
      });
      await ingestRuns(ctx, repo, res.data.workflow_runs, "RECONCILE", repoCtx);
      seen(res.data.workflow_runs);
      last = res.data.workflow_runs.length;
    }
  }

  const newEtag =
    typeof first.headers.etag === "string" ? first.headers.etag : null;
  const cursor = new Date(newest);
  await db.syncState.update({
    where: { repositoryId: repo.id },
    data: {
      runsCursor: cursor,
      needsResync: false,
      lastError: null,
      // The ETag only matches while the query is the same, i.e. the cursor did not move.
      runsEtag:
        newEtag && cursor.getTime() === state.runsCursor.getTime()
          ? `${created}${ETAG_SEPARATOR}${newEtag}`
          : null,
    },
  });
}

/**
 * e) Walks backwards in three-day windows until
 * `backfillUntil <= now - backfillDays`, persisting `backfillUntil` after each
 * leaf window. Returns true when the backfill is complete.
 */
export async function backfill(
  ctx: SyncContext,
  repo: SyncRepo,
): Promise<boolean> {
  const state = await syncState(repo, ctx.installationId);
  if (state.backfillDone) return true;
  const now = ctx.deadline.now();
  const target = new Date(now - ctx.backfillDays * 86_400_000);
  let until = state.backfillUntil ?? state.runsCursor ?? new Date(now);

  for (;;) {
    const w = nextBackfillWindow(until, target);
    if (!w) break;
    await syncWindow(ctx, repo, w, "BACKFILL", async (leaf) => {
      const leafFrom = new Date(leaf.from * 1000);
      if (leafFrom.getTime() < until.getTime()) {
        until = leafFrom;
        await db.syncState.update({
          where: { repositoryId: repo.id },
          data: { backfillUntil: until },
        });
      }
    });
    // Windows without runs or fully processed: continue below the window.
    const windowFrom = new Date(w.from * 1000);
    if (windowFrom.getTime() < until.getTime()) {
      until = windowFrom;
      await db.syncState.update({
        where: { repositoryId: repo.id },
        data: { backfillUntil: until },
      });
    }
  }

  await db.syncState.update({
    where: { repositoryId: repo.id },
    data: { backfillDone: true, backfillUntil: until, lastError: null },
  });
  return true;
}

type StaleJob = {
  id: bigint;
  repositoryId: bigint;
  runnerKind: string;
  createdAt: Date;
  ownerLogin: string;
  name: string;
};

/**
 * c) Re-reads jobs that are open with no event for 30 minutes, runs that are
 * open for an hour (five minutes in lean mode, where runs only come from
 * reconcile) and placeholder runs. A job that GitHub no longer has and that
 * is past its runtime limit (6 h hosted, 5 days self-hosted) is marked
 * cancelled. Runs on the reserve budget: only an explicit retry-after stops it.
 */
export async function repairStale(ctx: SyncContext): Promise<void> {
  const now = ctx.deadline.now();
  const jobs = await db.$queryRaw<StaleJob[]>`
    SELECT j."id", j."repositoryId", j."runnerKind"::text AS "runnerKind", j."createdAt",
           r."ownerLogin", r."name"
    FROM "WorkflowJob" j JOIN "Repository" r ON r."id" = j."repositoryId"
    WHERE j."installationId" = ${ctx.installationId}
      AND j."status" <> 'COMPLETED'
      AND j."lastEventAt" < ${new Date(now - STALE_JOB_MS)}
      AND r."installationId" = ${ctx.installationId}
    ORDER BY j."lastEventAt" ASC
    LIMIT ${STALE_BATCH}`;

  for (const job of jobs) {
    checkBudget(ctx, false);
    const at = new Date(ctx.deadline.now());
    try {
      ctx.stats.requests++;
      const res = await ctx.api.request<GhWorkflowJob>(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
        { owner: job.ownerLogin, repo: job.name, job_id: Number(job.id) },
      );
      await applyGhJobs(
        ctx.installationId,
        job.repositoryId,
        [res.data],
        at,
        "RECONCILE",
      );
      ctx.stats.jobs++;
    } catch (error) {
      if (errorStatus(error) !== 404) throw error;
      const limit =
        job.runnerKind === "SELF_HOSTED"
          ? SELF_HOSTED_JOB_LIMIT_MS
          : HOSTED_JOB_LIMIT_MS;
      await db.workflowJob.updateMany({
        where: { id: job.id, status: { not: "COMPLETED" } },
        data:
          at.getTime() - job.createdAt.getTime() > limit
            ? {
                status: "COMPLETED",
                statusRank: 4,
                conclusion: "CANCELLED",
                source: "RECONCILE",
                lastEventAt: at,
              }
            : { lastEventAt: at },
      });
    }
  }

  const runThreshold = new Date(
    now - (ctx.lean ? LEAN_STALE_RUN_MS : STALE_RUN_MS),
  );
  const runs = await db.$queryRaw<
    Array<{
      id: bigint;
      repositoryId: bigint;
      ownerLogin: string;
      name: string;
      defaultBranch: string;
      fullName: string;
    }>
  >`
    SELECT w."id", w."repositoryId", r."ownerLogin", r."name", r."defaultBranch", r."fullName"
    FROM "WorkflowRun" w JOIN "Repository" r ON r."id" = w."repositoryId"
    WHERE w."installationId" = ${ctx.installationId}
      AND r."installationId" = ${ctx.installationId}
      AND w."status" <> 'COMPLETED'
      AND (w."isPlaceholder" OR w."lastEventAt" < ${runThreshold})
    ORDER BY w."lastEventAt" ASC
    LIMIT ${STALE_BATCH}`;

  for (const run of runs) {
    checkBudget(ctx, false);
    const at = new Date(ctx.deadline.now());
    const repo: SyncRepo = {
      id: run.repositoryId,
      ownerLogin: run.ownerLogin,
      name: run.name,
      fullName: run.fullName,
      defaultBranch: run.defaultBranch,
    };
    try {
      ctx.stats.requests++;
      const res = await ctx.api.request<GhWorkflowRun>(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
        { owner: run.ownerLogin, repo: run.name, run_id: Number(run.id) },
      );
      await ingestRuns(ctx, repo, [res.data], "RECONCILE", undefined, false);
    } catch (error) {
      if (error instanceof DeadlineReached || error instanceof RateLimited)
        throw error;
      if (errorStatus(error) !== 404) throw error;
      await db.workflowRun.updateMany({
        where: { id: run.id },
        data: { lastEventAt: at },
      });
    }
  }
}
