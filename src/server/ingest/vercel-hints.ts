import "server-only";
import { describeError } from "@/lib/describe-error";
import { env } from "@/env";
import { db } from "@/server/db";
import { VercelError, type Fetch } from "@/server/vercel/client";
import { Deadline } from "./budget";
import { vercelCredentialFor } from "./vercel-credential";
import {
  noteVercelFailure,
  refreshProject,
  rollupDeploymentDays,
  updateLatestProduction,
  upsertProjects,
  vercelApiFor,
  type VercelStepResult,
} from "./vercel-reconcile";
import { effectiveRetentionDays } from "./prune";

/**
 * GitHub `deployment_status` events as freshness hints (design addendum
 * §7.3). The Vercel GitHub integration posts them to the repository; the
 * fold only marks the Vercel projects linked to that repository **in the
 * same installation** dirty and stores nothing from the payload. A targeted
 * refresh then re-reads the deployments of at most 3 of those projects from
 * Vercel (one GET each, 5 s in total), debounced to once per project per
 * 30 s. A project whose production deployment became ready is read once
 * more (GET /v9/projects/{id}): the serving deployment may not have moved
 * (a rollback pins it), and the "auto-assign paused" rule needs a project
 * read newer than that deployment. A spoofed or wrong hint costs one GET per
 * project at most; the state always comes from Vercel.
 *
 * Failures map like in the reconcile step: a rejected token revokes the
 * connection, a 429 pauses it until the retry time, so later hints make no
 * calls until a rotate or the reset.
 */

const DEBOUNCE_MS = 30_000;
const HINT_BUDGET_MS = 5_000;
const MAX_PROJECTS = 3;

export type HintPayload = {
  repository?: { id?: number | string | null } | null;
  deployment_status?: { state?: string | null } | null;
};

/** Marks the linked projects dirty; returns their ids (none without a link). */
export async function foldDeploymentHint(
  installationId: bigint,
  payload: HintPayload,
  now: Date,
): Promise<string[]> {
  const raw = payload.repository?.id;
  if (raw == null || !/^\d{1,20}$/.test(String(raw))) return [];
  const repositoryId = BigInt(raw);
  const repo = await db.repository.findFirst({
    where: {
      id: repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true },
  });
  if (!repo) return [];
  const projects = await db.vercelProject.findMany({
    where: {
      installationId,
      removedAt: null,
      connection: { revokedAt: null },
      OR: [
        { manualRepositoryId: repositoryId },
        { manualRepositoryId: null, repositoryId },
      ],
    },
    select: { id: true },
    take: 20,
  });
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  await db.vercelProject.updateMany({
    where: { installationId, id: { in: ids } },
    data: { dirtyAt: now },
  });
  return ids;
}

/** Claims the 30 s debounce of each project; returns the claimed ones. */
async function claimHintRefresh(
  installationId: bigint,
  projectIds: ReadonlyArray<string>,
  now: Date,
): Promise<string[]> {
  const claimed: string[] = [];
  for (const id of projectIds.slice(0, MAX_PROJECTS)) {
    const { count } = await db.vercelProject.updateMany({
      where: {
        id,
        installationId,
        OR: [
          { hintRefreshedAt: null },
          { hintRefreshedAt: { lt: new Date(now.getTime() - DEBOUNCE_MS) } },
        ],
      },
      data: { hintRefreshedAt: now },
    });
    if (count === 1) claimed.push(id);
  }
  return claimed;
}

/**
 * The targeted refresh after a hint: only while the connection is healthy
 * (not revoked, not paused by a 429). Other errors are logged and left to
 * the next pass; the projects stay dirty, so step v3 picks them up.
 */
export async function refreshFromHint(
  installationId: bigint,
  projectIds: ReadonlyArray<string>,
  opts: { now?: Date; fetch?: Fetch } = {},
): Promise<VercelStepResult | null> {
  const now = opts.now ?? new Date();
  const conn = await db.vercelConnection.findUnique({
    where: { installationId },
    select: {
      revokedAt: true,
      pausedUntil: true,
      installation: { select: { timezone: true, rawRetentionDays: true } },
    },
  });
  if (!conn || conn.revokedAt || (conn.pausedUntil && conn.pausedUntil > now))
    return null;
  const claimed = await claimHintRefresh(installationId, projectIds, now);
  if (claimed.length === 0) return null;
  const cred = await vercelCredentialFor(installationId);
  if (cred.kind !== "token") return null;
  const deadline = new Deadline(now.getTime() + HINT_BUDGET_MS, Date.now);
  const result: VercelStepResult = {
    status: "ok",
    projects: 0,
    deployments: 0,
    refreshed: 0,
    requests: 0,
  };
  const days = new Set<string>();
  const ctx = {
    installationId,
    timezone: conn.installation.timezone,
    api: vercelApiFor(cred.token, cred.teamId, deadline, opts.fetch),
    now,
    days,
    result,
  };
  try {
    const becameReady: string[] = [];
    for (const id of claimed)
      if (await refreshProject(ctx, id)) becameReady.push(id);
    for (const id of becameReady) {
      const project = await ctx.api.getProject(id);
      result.requests++;
      await upsertProjects(installationId, [project], now);
      result.projects++;
    }
  } catch (error) {
    if (await noteVercelFailure(installationId, error, now, cred.token)) {
      result.status =
        error instanceof VercelError && error.rateLimited
          ? "rate_limited"
          : "credential_error";
    } else {
      result.status = "partial";
      console.warn("Vercel hint refresh stopped", describeError(error));
    }
  }
  const retention = effectiveRetentionDays(
    conn.installation.rawRetentionDays,
    env.MAX_RETENTION_DAYS,
  );
  const oldest =
    retention != null ? new Date(now.getTime() - retention * 86_400_000) : null;
  await rollupDeploymentDays(
    installationId,
    conn.installation.timezone,
    [...days].filter((d) => !oldest || d >= oldest.toISOString().slice(0, 10)),
  );
  await updateLatestProduction(installationId, now);
  return result;
}
