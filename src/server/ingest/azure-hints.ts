import "server-only";
import { describeError } from "@/lib/describe-error";
import { env } from "@/env";
import { AzureError, type Fetch } from "@/server/azure/client";
import { db } from "@/server/db";
import { localDay } from "@/server/metrics/days";
import { Deadline } from "./budget";
import { azureCredentialFor } from "./azure-credential";
import { rollupPipelineDays } from "./azure-rollup";
import {
  CONN_SELECT,
  azureApiFor,
  noteAzureFailure,
  syncTimeline,
  upsertBuilds,
  type AzureStepResult,
} from "./azure-reconcile";
import { effectiveRetentionDays } from "./prune";

/**
 * GitHub check runs and suites of the Azure Pipelines GitHub App as
 * freshness hints (design addendum M7 §4.4). The fold acts only when the
 * App slug is the connection's `checkAppSlug`, the repository belongs to
 * this installation and is not ignored, and the connection is healthy. The
 * build id comes from `details_url` (`[?&]buildId=(\d+)`) or `external_id`
 * (`<definition>|<build>|…`, verify); it only selects what to refresh and
 * is never stored as truth. A targeted refresh then reads at most 3 builds
 * (one builds?buildIds call per project plus timelines, at most 3 calls in
 * total, 5 s), debounced to 30 s per build. Nothing from the payload is
 * stored. Check suites carry no build id: they mark the repository's
 * definitions dirty, so the next pass reads them first.
 *
 * Fallbacks when check runs of another App do not reach this App (M7.0):
 * check suites, then the Azure DevOps service hook, then polling.
 */

const DEBOUNCE_MS = 30_000;
const HINT_BUDGET_MS = 5_000;
const MAX_BUILDS = 3;
const MAX_CALLS = 3;

export type CheckHintPayload = {
  repository?: { id?: number | string | null } | null;
  check_run?: {
    app?: { slug?: string | null } | null;
    details_url?: string | null;
    external_id?: string | null;
    head_sha?: string | null;
  } | null;
  check_suite?: {
    app?: { slug?: string | null } | null;
    head_sha?: string | null;
  } | null;
};

/** The build id of a check run: details_url first, then external_id. */
export function buildIdOfCheck(
  detailsUrl: string | null | undefined,
  externalId: string | null | undefined,
): number | null {
  const fromUrl = detailsUrl
    ? /[?&]buildId=(\d{1,10})(?:&|$|#)/.exec(detailsUrl)
    : null;
  if (fromUrl) return Number(fromUrl[1]);
  const fromExt = externalId
    ? /^\d{1,10}\|(\d{1,10})(?:\||$)/.exec(externalId)
    : null;
  return fromExt ? Number(fromExt[1]) : null;
}

/** The project segment of a dev.azure.com details_url (id or name), if it is our organisation. */
export function projectOfCheck(
  detailsUrl: string | null | undefined,
  org: string,
): string | null {
  if (!detailsUrl) return null;
  try {
    const u = new URL(detailsUrl);
    if (u.origin !== "https://dev.azure.com") return null;
    const [o, p] = u.pathname.split("/").filter(Boolean);
    if (!o || !p || decodeURIComponent(o).toLowerCase() !== org.toLowerCase())
      return null;
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

export type CheckHint = {
  /** Builds to refresh: (project, build id). */
  builds: Array<{ projectId: string; buildId: number }>;
};

/** Marks the hinted builds (or the repo's definitions) dirty; returns what to refresh. */
export async function foldCheckHint(
  installationId: bigint,
  event: "check_run" | "check_suite",
  payload: CheckHintPayload,
  now: Date,
): Promise<CheckHint | null> {
  const rawRepo = payload.repository?.id;
  if (rawRepo == null || !/^\d{1,20}$/.test(String(rawRepo))) return null;
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      checkAppSlug: true,
      revokedAt: true,
      pausedUntil: true,
      orgName: true,
    },
  });
  if (!conn || conn.revokedAt || (conn.pausedUntil && conn.pausedUntil > now))
    return null;
  const check = event === "check_run" ? payload.check_run : payload.check_suite;
  if (!check || check.app?.slug !== conn.checkAppSlug) return null;
  const repositoryId = BigInt(rawRepo);
  const repo = await db.repository.findFirst({
    where: {
      id: repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true },
  });
  if (!repo) return null;
  const linked = {
    installationId,
    removedAt: null,
    OR: [
      { manualRepositoryId: repositoryId },
      { manualRepositoryId: null, repositoryId },
    ],
  };
  const sha =
    check.head_sha && /^[0-9a-f]{40}$/i.test(check.head_sha)
      ? check.head_sha.toLowerCase()
      : null;
  const builds: CheckHint["builds"] = [];
  if (event === "check_run") {
    const run = payload.check_run!;
    const buildId = buildIdOfCheck(run.details_url, run.external_id);
    if (buildId != null) {
      const stored = await db.azureBuild.findFirst({
        where: { installationId, id: buildId },
        select: { projectId: true },
      });
      if (stored) {
        await db.azureBuild.updateMany({
          where: { installationId, id: buildId },
          data: { dirtyAt: now },
        });
        builds.push({ projectId: stored.projectId, buildId });
      } else {
        const segment = projectOfCheck(run.details_url, conn.orgName);
        const project = segment
          ? await db.azureDevOpsProject.findFirst({
              where: {
                installationId,
                selected: true,
                removedAt: null,
                OR: [{ id: segment.toLowerCase() }, { name: segment }],
              },
              select: { id: true },
            })
          : null;
        if (project) builds.push({ projectId: project.id, buildId });
      }
    }
  }
  if (sha)
    await db.azureBuild.updateMany({
      where: { installationId, headSha: sha, repositoryId },
      data: { dirtyAt: now },
    });
  await db.azurePipelineDefinition.updateMany({
    where: linked,
    data: { dirtyAt: now },
  });
  return { builds: builds.slice(0, MAX_BUILDS) };
}

/**
 * The debounce of builds without a row yet (not stored because their
 * definition is not linked, or not listed by Azure DevOps): a bounded
 * in-process map, so a burst of check_run deliveries for such a build
 * makes one call per 30 s and instance instead of one per event.
 */
const UNSTORED_MAX = 2_000;
const unstored = new Map<string, number>();

function claimUnstored(
  installationId: bigint,
  buildId: number,
  now: Date,
): boolean {
  const key = `${installationId}:${buildId}`;
  const at = unstored.get(key);
  if (at !== undefined && now.getTime() - at < DEBOUNCE_MS) return false;
  unstored.delete(key);
  unstored.set(key, now.getTime());
  while (unstored.size > UNSTORED_MAX) {
    const oldest = unstored.keys().next().value;
    if (oldest === undefined) break;
    unstored.delete(oldest);
  }
  return true;
}

/** Tests only. */
export function clearAzureHintDebounce(): void {
  unstored.clear();
}

/**
 * A hint for a build of an unknown definition re-lists the definitions at
 * most once in this window (the next pass after the reset does it).
 */
const DEFINITIONS_RESET_COOLDOWN_MS = 30 * 60_000;

/** Claims the 30 s debounce of each build; returns the claimed ones. */
async function claim(
  installationId: bigint,
  builds: CheckHint["builds"],
  now: Date,
): Promise<CheckHint["builds"]> {
  const out: CheckHint["builds"] = [];
  for (const b of builds.slice(0, MAX_BUILDS)) {
    const exists = await db.azureBuild.findFirst({
      where: { installationId, id: b.buildId },
      select: { hintRefreshedAt: true },
    });
    if (!exists) {
      if (claimUnstored(installationId, b.buildId, now)) out.push(b);
      continue;
    }
    const { count } = await db.azureBuild.updateMany({
      where: {
        installationId,
        id: b.buildId,
        OR: [
          { hintRefreshedAt: null },
          { hintRefreshedAt: { lt: new Date(now.getTime() - DEBOUNCE_MS) } },
        ],
      },
      data: { hintRefreshedAt: now },
    });
    if (count === 1) out.push(b);
  }
  return out;
}

/**
 * The targeted refresh after a hint or a service hook delivery: at most 3
 * builds and 3 calls in 5 s, only while the connection is healthy. Other
 * errors are logged; the builds stay dirty, so step z3 reads them first.
 */
export async function refreshAzureBuilds(
  installationId: bigint,
  builds: CheckHint["builds"],
  opts: { now?: Date; fetch?: Fetch } = {},
): Promise<AzureStepResult | null> {
  const now = opts.now ?? new Date();
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      ...CONN_SELECT,
      installation: { select: { timezone: true, rawRetentionDays: true } },
    },
  });
  if (!conn || conn.revokedAt || (conn.pausedUntil && conn.pausedUntil > now))
    return null;
  const claimed = await claim(installationId, builds, now);
  if (claimed.length === 0) return null;
  const timezone = conn.installation.timezone;
  const result: AzureStepResult = {
    status: "ok",
    definitions: 0,
    builds: 0,
    timelines: 0,
    requests: 0,
  };
  let secrets: string[] = [conn.orgName];
  const deadline = new Deadline(now.getTime() + HINT_BUDGET_MS, Date.now);
  const days = new Set<string>();
  try {
    const cred = await azureCredentialFor(installationId, {
      fetch: opts.fetch,
    });
    if (cred.kind !== "token") return null;
    secrets = [...cred.secrets, conn.orgName];
    const api = azureApiFor(cred.org, cred.auth, deadline, opts.fetch, {
      maxRequests: MAX_CALLS,
    });
    const byProject = new Map<string, number[]>();
    for (const b of claimed)
      byProject.set(b.projectId, [
        ...(byProject.get(b.projectId) ?? []),
        b.buildId,
      ]);
    let unknownDefinition = false;
    for (const [projectId, ids] of byProject) {
      const r = await api.listBuilds(projectId, {
        buildIds: ids,
        top: ids.length,
      });
      const known = new Set(
        (
          await db.azurePipelineDefinition.findMany({
            where: {
              installationId,
              projectId,
              id: { in: r.builds.map((b) => b.definition?.id ?? -1) },
            },
            select: { id: true },
          })
        ).map((d) => d.id),
      );
      if (r.builds.some((b) => b.definition && !known.has(b.definition.id)))
        unknownDefinition = true;
      result.builds += await upsertBuilds(
        installationId,
        timezone,
        r.builds,
        projectId,
        now,
        days,
      );
    }
    // A build first seen here starts its debounce window now.
    await db.azureBuild.updateMany({
      where: {
        installationId,
        id: { in: claimed.map((b) => b.buildId) },
        hintRefreshedAt: null,
      },
      data: { hintRefreshedAt: now },
    });
    if (unknownDefinition)
      await db.azureDevOpsConnection.updateMany({
        where: {
          installationId,
          definitionsSyncedAt: {
            lt: new Date(now.getTime() - DEFINITIONS_RESET_COOLDOWN_MS),
          },
        },
        data: { definitionsSyncedAt: null },
      });
    // Timelines with the calls that are left.
    const ctx = {
      installationId,
      timezone,
      api,
      now,
      conn,
      result,
      days,
    };
    for (const b of claimed) {
      if (api.transport.requests >= MAX_CALLS) break;
      const row = await db.azureBuild.findFirst({
        where: { installationId, id: b.buildId },
        select: {
          id: true,
          projectId: true,
          definitionId: true,
          repositoryId: true,
          queuedAt: true,
          status: true,
          result: true,
        },
      });
      if (row) await syncTimeline(ctx, row);
    }
    result.requests = api.transport.requests;
  } catch (error) {
    if (await noteAzureFailure(installationId, error, now, secrets)) {
      result.status =
        error instanceof AzureError && error.rateLimited
          ? "rate_limited"
          : "credential_error";
    } else {
      result.status = "partial";
      console.warn("Azure DevOps hint refresh stopped", describeError(error));
    }
  }
  const retention = effectiveRetentionDays(
    conn.installation.rawRetentionDays,
    env.MAX_RETENTION_DAYS,
  );
  const oldest =
    retention != null
      ? localDay(new Date(now.getTime() - retention * 86_400_000), timezone)
      : null;
  await rollupPipelineDays(
    installationId,
    timezone,
    [...days].filter((d) => !oldest || d >= oldest),
  );
  return result;
}
