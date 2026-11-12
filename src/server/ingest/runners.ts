import "server-only";
import { db } from "@/server/db";
import { normalizeLabels } from "@/server/metrics/classify";
import { nextSampleInterval } from "@/server/metrics/runners";
import {
  DeadlineReached,
  RateLimited,
  type Deadline,
  type RateBudget,
} from "./budget";
import { errorStatus, pages, type GitHubApi } from "./github-client";
import { redactError } from "./webhook";

/**
 * Reconcile step f, runner sampling (design §5.3 f, §6.5).
 *
 * Every tick lists the org runners (organization installations with
 * Organization "Self-hosted runners: read") and the repo-level runners of
 * every repository that has a known repo runner or has run a self-hosted job
 * (repository "Administration: read"). Once a day a discovery pass lists the
 * runners of every active repository, so a persistent per-repo runner shows
 * up before its first job. Discovery is skipped while the rate budget pauses;
 * a pass cut short by the deadline or the budget stores a cursor (the last
 * repository listed, AppState "runner-discovery:<installationId>") and the
 * next tick continues from there. `runnersDiscoveredAt` is set only when a
 * pass reached the last repository.
 *
 * Each listed runner is upserted into the Runner cache and gets a
 * RunnerSample(online, busy, intervalS). A runner missing from a list that
 * was read completely gets `removedAt`; one that ran at most one job is then
 * marked ephemeral. Lazy views of /runners sample too, at most every 2 min.
 */

export const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const LAZY_SAMPLE_INTERVAL_MS = 2 * 60 * 1000;
const RESERVE_MS = 5_000;

type GhRunner = {
  id: number;
  name: string;
  os: string;
  status: string;
  busy: boolean;
  ephemeral?: boolean;
  labels?: Array<{ name: string } | string>;
  runner_group_name?: string | null;
};

type RunnerList = { total_count: number; runners: GhRunner[] };

export type RunnerSyncContext = {
  installationId: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  permissions: Record<string, unknown>;
  /** sync.runners token, rate-budgeted and deadline-bounded. */
  api: GitHubApi;
  budget: RateBudget;
  deadline: Deadline;
  /** Target sample interval (the cron interval); intervalS is capped at twice that. */
  targetIntervalS: number;
};

export type RunnerSampleResult = {
  scopes: number;
  runners: number;
  samples: number;
  removed: number;
  discovery: "done" | "skipped" | "not_due" | "partial";
  /** Repo runner lists are unavailable without repository Administration: read. */
  repoRunnersGranted: boolean;
  orgRunnersGranted: boolean;
};

const granted = (perms: Record<string, unknown>, name: string) =>
  perms[name] === "read" || perms[name] === "write";

export function runnerKeyFor(
  installationId: bigint,
  scope: "ORG" | "REPO",
  githubRunnerId: number | bigint,
): string {
  return `${installationId}:${scope}:${githubRunnerId}`;
}

function labelsOf(r: GhRunner): string[] {
  return normalizeLabels(
    (r.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
  );
}

async function listAll(
  api: GitHubApi,
  route: string,
  params: Record<string, unknown>,
): Promise<GhRunner[]> {
  const out: GhRunner[] = [];
  for await (const page of pages<RunnerList>(api, route, {
    ...params,
    per_page: 100,
  })) {
    out.push(...(page.data.runners ?? []));
  }
  return out;
}

type Listed = {
  scope: "ORG" | "REPO";
  repositoryId: bigint | null;
  runners: GhRunner[];
};

/** Persists one complete runner list: upserts, samples and removals. */
async function applyList(
  ctx: RunnerSyncContext,
  listed: Listed,
  now: Date,
): Promise<{ runners: number; samples: number; removed: number }> {
  const existing = await db.runner.findMany({
    where: {
      installationId: ctx.installationId,
      scope: listed.scope,
      ...(listed.scope === "REPO" ? { repositoryId: listed.repositoryId } : {}),
    },
  });
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const seen = new Set<string>();
  let samples = 0;

  for (const gh of listed.runners) {
    const key = runnerKeyFor(ctx.installationId, listed.scope, gh.id);
    seen.add(key);
    const prev = byKey.get(key);
    const online = gh.status === "online";
    const busy = !!gh.busy;
    const fields = {
      name: gh.name,
      os: gh.os ?? "unknown",
      labels: labelsOf(gh),
      groupName: gh.runner_group_name ?? prev?.groupName ?? null,
      online,
      busy,
      lastSeenAt: now,
      ...(online ? { lastOnlineAt: now } : {}),
      removedAt: null,
      ...(gh.ephemeral ? { ephemeral: true } : {}),
    };
    await db.runner.upsert({
      where: { key },
      create: {
        key,
        installationId: ctx.installationId,
        scope: listed.scope,
        repositoryId: listed.repositoryId,
        githubRunnerId: BigInt(gh.id),
        firstSeenAt: now,
        ...fields,
      },
      update: fields,
    });
    const last = prev && !prev.removedAt ? prev.lastSeenAt : null;
    const { count } = await db.runnerSample.createMany({
      data: [
        {
          installationId: ctx.installationId,
          runnerKey: key,
          sampledAt: now,
          online,
          busy,
          intervalS: nextSampleInterval(last, now, ctx.targetIntervalS),
        },
      ],
      skipDuplicates: true,
    });
    samples += count;
  }

  let removed = 0;
  for (const r of existing) {
    if (seen.has(r.key) || r.removedAt) continue;
    const jobs = await db.workflowJob.count({
      where: { installationId: ctx.installationId, runnerName: r.name },
    });
    await db.runner.update({
      where: { key: r.key },
      data: {
        removedAt: now,
        online: false,
        busy: false,
        ...(jobs <= 1 && !r.ephemeral ? { ephemeral: true } : {}),
      },
    });
    removed++;
  }
  return { runners: listed.runners.length, samples, removed };
}

function guard(ctx: RunnerSyncContext) {
  if (ctx.deadline.expired(RESERVE_MS)) throw new DeadlineReached();
  if (ctx.budget.paused()) throw new RateLimited(ctx.budget.retryAt());
}

const stopped = (ctx: RunnerSyncContext) =>
  ctx.deadline.expired(RESERVE_MS) || ctx.budget.paused();

/**
 * One repository's runners; null when GitHub will not answer for it (403,
 * 404, 5xx): that must not stop the others, and its cached runners stay as
 * they are. Deadline and rate-limit stops propagate.
 */
async function listRepoRunners(
  ctx: RunnerSyncContext,
  repo: { ownerLogin: string; name: string },
): Promise<GhRunner[] | null> {
  try {
    return await listAll(ctx.api, "GET /repos/{owner}/{repo}/actions/runners", {
      owner: repo.ownerLogin,
      repo: repo.name,
    });
  } catch (error) {
    if (error instanceof DeadlineReached || error instanceof RateLimited)
      throw error;
    const status = errorStatus(error);
    if (status !== 403 && status !== 404) {
      console.warn("runner list failed", {
        status,
        error: redactError(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
    return null;
  }
}

const cursorKey = (installationId: bigint) =>
  `runner-discovery:${installationId}`;

/** The last repository id a partial discovery pass listed; null to start at the first. */
export async function discoveryCursor(
  installationId: bigint,
): Promise<bigint | null> {
  const row = await db.appState.findUnique({
    where: { key: cursorKey(installationId) },
  });
  const after = (row?.value as { afterRepositoryId?: unknown } | undefined)
    ?.afterRepositoryId;
  return typeof after === "string" && /^\d+$/.test(after)
    ? BigInt(after)
    : null;
}

async function setDiscoveryCursor(
  installationId: bigint,
  after: bigint | null,
): Promise<void> {
  const key = cursorKey(installationId);
  if (after == null) {
    await db.appState.deleteMany({ where: { key } });
    return;
  }
  const value = { afterRepositoryId: String(after) };
  await db.appState.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/**
 * Samples the installation's runners (step f). `discovery` lists the repo
 * runners of every active repository instead of only the known ones; pass
 * "auto" to run it when the last discovery is older than a day.
 */
export async function sampleRunners(
  ctx: RunnerSyncContext,
  discovery: boolean | "auto" = "auto",
): Promise<RunnerSampleResult> {
  const now = new Date(ctx.deadline.now());
  const orgGranted =
    ctx.accountType === "ORGANIZATION" &&
    granted(ctx.permissions, "organization_self_hosted_runners");
  const repoGranted = granted(ctx.permissions, "administration");
  const result: RunnerSampleResult = {
    scopes: 0,
    runners: 0,
    samples: 0,
    removed: 0,
    discovery: "not_due",
    repoRunnersGranted: repoGranted,
    orgRunnersGranted: orgGranted,
  };

  const inst = await db.installation.findUnique({
    where: { id: ctx.installationId },
    select: { runnersDiscoveredAt: true },
  });
  let discover =
    discovery === "auto"
      ? !inst?.runnersDiscoveredAt ||
        now.getTime() - inst.runnersDiscoveredAt.getTime() >=
          DISCOVERY_INTERVAL_MS
      : discovery;
  if (discover && ctx.budget.paused()) {
    discover = false;
    result.discovery = "skipped";
  }

  const add = (r: { runners: number; samples: number; removed: number }) => {
    result.scopes++;
    result.runners += r.runners;
    result.samples += r.samples;
    result.removed += r.removed;
  };

  if (orgGranted) {
    guard(ctx);
    const runners = await listAll(ctx.api, "GET /orgs/{org}/actions/runners", {
      org: ctx.accountLogin,
    });
    add(
      await applyList(ctx, { scope: "ORG", repositoryId: null, runners }, now),
    );
  }

  if (repoGranted) {
    // Known repos every tick: a repo runner is cached, or a self-hosted job ran.
    const knownRunnerRepos = (
      await db.runner.findMany({
        where: {
          installationId: ctx.installationId,
          scope: "REPO",
          removedAt: null,
        },
        select: { repositoryId: true },
        distinct: ["repositoryId"],
      })
    )
      .map((r) => r.repositoryId)
      .filter((id): id is bigint => id != null);
    const known = await db.repository.findMany({
      where: {
        installationId: ctx.installationId,
        removedAt: null,
        OR: [{ hasSelfHosted: true }, { id: { in: knownRunnerRepos } }],
      },
      orderBy: { id: "asc" },
      select: { id: true, ownerLogin: true, name: true },
    });
    for (const repo of known) {
      guard(ctx);
      const runners = await listRepoRunners(ctx, repo);
      if (runners)
        add(
          await applyList(
            ctx,
            { scope: "REPO", repositoryId: repo.id, runners },
            now,
          ),
        );
    }

    if (discover) {
      // Discovery resumes after the last repo a previous pass listed, so a
      // pass cut short by the deadline or the rate budget never starts over.
      const after = await discoveryCursor(ctx.installationId);
      const knownIds = new Set(known.map((r) => r.id));
      const rest = await db.repository.findMany({
        where: {
          installationId: ctx.installationId,
          removedAt: null,
          ...(after != null ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        select: { id: true, ownerLogin: true, name: true },
      });
      let last: bigint | null = null;
      let complete = true;
      for (const repo of rest) {
        if (knownIds.has(repo.id)) {
          last = repo.id;
          continue;
        }
        if (stopped(ctx)) {
          complete = false;
          break;
        }
        let runners: GhRunner[] | null;
        try {
          runners = await listRepoRunners(ctx, repo);
        } catch (error) {
          if (
            error instanceof DeadlineReached ||
            error instanceof RateLimited
          ) {
            complete = false;
            break;
          }
          throw error;
        }
        if (runners)
          add(
            await applyList(
              ctx,
              { scope: "REPO", repositoryId: repo.id, runners },
              now,
            ),
          );
        last = repo.id;
      }
      if (complete) {
        await setDiscoveryCursor(ctx.installationId, null);
        result.discovery = "done";
      } else {
        if (last != null) await setDiscoveryCursor(ctx.installationId, last);
        result.discovery = "partial";
      }
    }
  } else if (discover) {
    result.discovery = "done";
  }

  await db.installation.updateMany({
    where: { id: ctx.installationId },
    data: {
      runnersSampledAt: now,
      ...(result.discovery === "done" ? { runnersDiscoveredAt: now } : {}),
    },
  });
  return result;
}

/**
 * Claims a lazy sample for /runners page views: true for at most one caller
 * per installation every two minutes.
 */
export async function claimLazyRunnerSample(
  installationId: bigint,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await db.installation.updateMany({
    where: {
      id: installationId,
      deletedAt: null,
      suspendedAt: null,
      OR: [
        { runnersSampledAt: null },
        {
          runnersSampledAt: {
            lt: new Date(now.getTime() - LAZY_SAMPLE_INTERVAL_MS),
          },
        },
      ],
    },
    data: { runnersSampledAt: now },
  });
  return count === 1;
}
