import "server-only";
import { db } from "@/server/db";
import type { Source } from "./fold";
import {
  jobEventFrom,
  runEventFrom,
  type GhWorkflowJob,
  type GhWorkflowRun,
  type WorkflowJobPayload,
  type WorkflowRunPayload,
} from "./github-map";
import {
  applyJobEvents,
  applyRunEvent,
  loadRepoContext,
  type RepoContext,
} from "./history";
import { upsertRepositories } from "./inventory";
import type { GhRepository } from "./types";

/**
 * `workflow_job` and `workflow_run` deliveries and REST snapshots, folded
 * through the same functions (design §5.2). Webhook replays pass the
 * delivery's receivedAt as the event time, so a replay folds exactly like the
 * original delivery would have.
 */

/** Makes sure the repository is known (a delivery can precede discovery). */
export async function ensureRepository(
  installationId: bigint,
  repo: GhRepository,
): Promise<{ defaultBranch: string | null }> {
  const id = BigInt(repo.id);
  const existing = await db.repository.findUnique({
    where: { id },
    select: { installationId: true, defaultBranch: true, removedAt: true },
  });
  if (existing && existing.installationId === installationId) {
    return { defaultBranch: repo.default_branch ?? existing.defaultBranch };
  }
  await upsertRepositories(installationId, [repo]);
  return { defaultBranch: repo.default_branch ?? null };
}

export async function handleWorkflowJobEvent(
  installationId: bigint,
  payload: WorkflowJobPayload,
  receivedAt: Date,
  source: Source = "WEBHOOK",
): Promise<void> {
  await ensureRepository(installationId, payload.repository);
  await applyGhJobs(
    installationId,
    BigInt(payload.repository.id),
    [payload.workflow_job],
    receivedAt,
    source,
  );
}

export async function handleWorkflowRunEvent(
  installationId: bigint,
  payload: WorkflowRunPayload,
  receivedAt: Date,
  source: Source = "WEBHOOK",
): Promise<void> {
  const { defaultBranch } = await ensureRepository(
    installationId,
    payload.repository,
  );
  await applyGhRun(
    installationId,
    BigInt(payload.repository.id),
    payload.workflow_run,
    defaultBranch,
    receivedAt,
    source,
  );
}

export async function applyGhRun(
  installationId: bigint,
  repositoryId: bigint,
  run: GhWorkflowRun,
  defaultBranch: string | null,
  eventAt: Date,
  source: Source,
  ctx?: RepoContext,
) {
  return applyRunEvent(
    runEventFrom(run, {
      installationId,
      repositoryId,
      defaultBranch,
      eventAt,
      source,
    }),
    ctx ?? (await loadRepoContext(installationId, repositoryId)),
  );
}

export async function applyGhJobs(
  installationId: bigint,
  repositoryId: bigint,
  jobs: ReadonlyArray<GhWorkflowJob>,
  eventAt: Date,
  source: Source,
  ctx?: RepoContext,
) {
  return applyJobEvents(
    jobs.map((job) => ({
      job: jobEventFrom(job, { installationId, repositoryId, eventAt, source }),
      headSha: job.head_sha,
      headBranch: job.head_branch ?? null,
    })),
    ctx ?? (await loadRepoContext(installationId, repositoryId)),
  );
}
