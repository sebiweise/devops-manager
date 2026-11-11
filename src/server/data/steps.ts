import "server-only";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import { errorStatus, type GitHubClients } from "@/server/ingest/github-client";
import { githubClients } from "@/server/ingest/triggers";
import { inScope, NotFoundError } from "./installations";

/**
 * Steps of the jobs of one run attempt, read live from GitHub (design §7 run
 * detail, "steps loaded live"). Steps are never stored. The run must belong
 * to a visible installation of the scope; otherwise NotFoundError is thrown
 * before a token is minted.
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
    select: { repositoryId: true },
  });
  if (!run) throw new NotFoundError();
  const repo = await db.repository.findFirst({
    where: { id: run.repositoryId, installationId, removedAt: null },
    select: { id: true, ownerLogin: true, name: true },
  });
  if (!repo) return { status: "expired" };

  try {
    const api = await clients.installation(
      installationId,
      "sync.runs",
      (inst.permissions ?? {}) as Record<string, unknown>,
      [repo.id],
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
  }
}
