import "server-only";
import { LRUCache } from "lru-cache";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import { RateBudget } from "@/server/ingest/budget";
import {
  errorStatus,
  withBudget,
  type GitHubClients,
} from "@/server/ingest/github-client";
import {
  belowInteractiveFloor,
  persistRateBudget,
  storedCoreBudget,
} from "@/server/ingest/rate-store";
import { githubClients } from "@/server/ingest/triggers";
import { inScope, NotFoundError } from "./installations";

/**
 * Steps of the jobs of one run attempt, read live from GitHub (design §7 run
 * detail, "steps loaded live"). Steps are never stored. The run must belong
 * to a visible installation of the scope; otherwise NotFoundError is thrown
 * before a token is minted.
 *
 * GitHub is called at most once per (installation, run, attempt) and TTL:
 * results are cached in memory (30 s while the run is live, which matches
 * the page's auto refresh, 10 minutes once it completed), concurrent views
 * share one request, and no request is made while the installation's stored
 * rate budget is below the interactive floor. The rate-limit headers of
 * these calls are recorded like reconcile's.
 */

export type StepDto = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationS: number | null;
};

export type RunSteps =
  | { status: "ok"; byJob: Record<string, StepDto[]> }
  /** GitHub no longer has the run (retention) or the repository. */
  | { status: "expired" }
  | { status: "unavailable" };

type GhStep = {
  number?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

type GhJobWithSteps = { id: number; steps?: GhStep[] };

const PER_PAGE = 100;
const MAX_PAGES = 5;
const LIVE_TTL_MS = 30_000;
const COMPLETED_TTL_MS = 10 * 60_000;

const cache = new LRUCache<string, Promise<RunSteps>>({
  max: 500,
  ttl: LIVE_TTL_MS,
});

/** Empties the steps cache (tests). */
export function resetStepsCache(): void {
  cache.clear();
}

export function mapSteps(steps: ReadonlyArray<GhStep> | undefined): StepDto[] {
  return (steps ?? [])
    .map((s, i) => {
      const started = s.started_at ? Date.parse(s.started_at) : NaN;
      const completed = s.completed_at ? Date.parse(s.completed_at) : NaN;
      return {
        number: s.number ?? i + 1,
        name: s.name ?? "",
        status: (s.status ?? "").toUpperCase(),
        conclusion: s.conclusion ? s.conclusion.toUpperCase() : null,
        startedAt: Number.isFinite(started)
          ? new Date(started).toISOString()
          : null,
        completedAt: Number.isFinite(completed)
          ? new Date(completed).toISOString()
          : null,
        durationS:
          Number.isFinite(started) && Number.isFinite(completed)
            ? Math.max(0, Math.round((completed - started) / 1000))
            : null,
      };
    })
    .sort((a, b) => a.number - b.number);
}

export async function getRunSteps(
  scope: TenantScope,
  installationId: bigint,
  runId: bigint,
  attempt: number,
  clients: GitHubClients = githubClients,
): Promise<RunSteps> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: { permissions: true },
  });
  if (!inst) throw new NotFoundError();
  const run = await db.workflowRun.findFirst({
    where: { id: runId, installationId },
    select: { repositoryId: true, status: true },
  });
  if (!run) throw new NotFoundError();
  const repo = await db.repository.findFirst({
    where: {
      id: run.repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true, ownerLogin: true, name: true },
  });
  if (!repo) return { status: "expired" };

  const key = `${installationId}|${runId}|${attempt}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = fetchSteps(
    installationId,
    (inst.permissions ?? {}) as Record<string, unknown>,
    repo,
    runId,
    attempt,
    clients,
  );
  // Only live runs change; "unavailable" is retried after the short TTL.
  cache.set(key, pending, {
    ttl: run.status === "COMPLETED" ? COMPLETED_TTL_MS : LIVE_TTL_MS,
  });
  try {
    const res = await pending;
    if (res.status === "unavailable")
      cache.set(key, pending, { ttl: LIVE_TTL_MS });
    return res;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

async function fetchSteps(
  installationId: bigint,
  permissions: Record<string, unknown>,
  repo: { id: bigint; ownerLogin: string; name: string },
  runId: bigint,
  attempt: number,
  clients: GitHubClients,
): Promise<RunSteps> {
  if (belowInteractiveFloor(await storedCoreBudget(installationId), Date.now()))
    return { status: "unavailable" };
  const budget = new RateBudget();
  try {
    const api = withBudget(
      await clients.installation(installationId, "sync.runs", permissions, [
        repo.id,
      ]),
      budget,
    );
    const byJob: Record<string, StepDto[]> = {};
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await api.request<{
        total_count: number;
        jobs: GhJobWithSteps[];
      }>(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
        {
          owner: repo.ownerLogin,
          repo: repo.name,
          run_id: Number(runId),
          attempt_number: attempt,
          per_page: PER_PAGE,
          page,
        },
      );
      for (const job of res.data.jobs)
        byJob[String(job.id)] = mapSteps(job.steps);
      if (
        res.data.jobs.length < PER_PAGE ||
        Object.keys(byJob).length >= res.data.total_count
      )
        break;
    }
    return { status: "ok", byJob };
  } catch (error) {
    const status = errorStatus(error);
    if (status === 404 || status === 410) return { status: "expired" };
    console.error(
      "steps not loaded",
      error instanceof Error ? error.message : "unknown",
    );
    return { status: "unavailable" };
  } finally {
    await persistRateBudget(installationId, budget).catch(() => undefined);
  }
}
