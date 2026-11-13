import "server-only";
import { db } from "@/server/db";
import type { Deadline } from "./budget";

/**
 * Reconcile step i) prune (design §5.5), once a day, in batches of 5,000 by
 * primary key so no statement runs long.
 *
 * | Data                         | Rule                                          |
 * | WorkflowJob, WorkflowRun     | older than rawRetentionDays (capped by MAX_RETENTION_DAYS, 0 = unlimited) |
 * | WebhookDelivery              | deleted after 14 days; FAILED/DEAD payloads nulled after 7 days |
 * | RunnerSample                 | 30 days                                       |
 * | Installations past purgeAfter| every row of the installation                 |
 * | VercelDeployment             | older than rawRetentionDays, except each project's latest production and latest preview per branch |
 * | AzureBuild (+ jobs)          | older than rawRetentionDays, except each definition's latest default-branch build |
 * | AzureJobRequest              | older than max(rawRetentionDays, 35 days) (DailyAzureUsage keeps the figures) |
 * | AzurePoolSample              | 30 days                                       |
 * | Findings FIXED               | 90 days after they were resolved              |
 * | Daily stats, BillingUsageItem| kept forever                                  |
 */

const BATCH = 5_000;
const DAY_MS = 86_400_000;
export const PRUNE_INTERVAL_MS = DAY_MS;
/** RunnerSample retention (design §5.5). */
export const SAMPLE_RETENTION_DAYS = 30;
const GLOBAL_PRUNE_KEY = "lastGlobalPruneAt";

/** Effective raw retention in days; null = unlimited. */
export function effectiveRetentionDays(
  rawRetentionDays: number,
  maxRetentionDays: number,
): number | null {
  if (maxRetentionDays === 0)
    return rawRetentionDays > 0 ? rawRetentionDays : null;
  return Math.min(rawRetentionDays, maxRetentionDays);
}

async function deleteInBatches(
  deadline: Deadline,
  run: () => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    if (deadline.expired()) return total;
    const n = await run();
    total += n;
    if (n < BATCH) return total;
  }
}

/** Raw history of one installation older than its retention. */
export async function pruneInstallation(
  installationId: bigint,
  retentionDays: number | null,
  deadline: Deadline,
): Promise<{
  jobs: number;
  runs: number;
  samples: number;
  deployments?: number;
  azureBuilds?: number;
}> {
  const samples = await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "RunnerSample" WHERE ctid IN (
        SELECT ctid FROM "RunnerSample"
        WHERE "installationId" = ${installationId}
          AND "sampledAt" < ${new Date(deadline.now() - SAMPLE_RETENTION_DAYS * DAY_MS)}
        LIMIT ${BATCH})`,
  );
  await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "AzurePoolSample" WHERE ctid IN (
        SELECT ctid FROM "AzurePoolSample"
        WHERE "installationId" = ${installationId}
          AND "at" < ${new Date(deadline.now() - SAMPLE_RETENTION_DAYS * DAY_MS)}
        LIMIT ${BATCH})`,
  );
  if (retentionDays == null) return { jobs: 0, runs: 0, samples };
  const cutoff = new Date(deadline.now() - retentionDays * DAY_MS);
  const jobs = await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "WorkflowJob" WHERE "id" IN (
        SELECT "id" FROM "WorkflowJob"
        WHERE "installationId" = ${installationId} AND "createdAt" < ${cutoff}
        LIMIT ${BATCH})`,
  );
  const runs = await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "WorkflowRun" WHERE "id" IN (
        SELECT "id" FROM "WorkflowRun"
        WHERE "installationId" = ${installationId} AND "createdAt" < ${cutoff}
        LIMIT ${BATCH})`,
  );
  // Vercel deployments: the latest production and the latest preview per
  // branch of every project stay, so the cards never go blank.
  const deployments = await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "VercelDeployment" WHERE "id" IN (
        SELECT d."id" FROM "VercelDeployment" d
        WHERE d."installationId" = ${installationId} AND d."createdAt" < ${cutoff}
          AND d."id" NOT IN (
            SELECT DISTINCT ON (k."projectId", k."target",
                   CASE WHEN k."target" = 'production' THEN '' ELSE coalesce(k."branch", '') END)
                   k."id"
            FROM "VercelDeployment" k
            WHERE k."installationId" = ${installationId}
            ORDER BY k."projectId", k."target",
                   CASE WHEN k."target" = 'production' THEN '' ELSE coalesce(k."branch", '') END,
                   k."createdAt" DESC)
        LIMIT ${BATCH})`,
  );
  // Azure Pipelines builds and their job rows: each definition's latest
  // default-branch build stays (the failing finding and the cards).
  const azureCutoff = cutoff;
  const azureBuilds = await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      WITH doomed AS (
        SELECT b."id" FROM "AzureBuild" b
        WHERE b."installationId" = ${installationId} AND b."queuedAt" < ${azureCutoff}
          AND b."id" NOT IN (
            SELECT DISTINCT ON (k."projectId", k."definitionId") k."id"
            FROM "AzureBuild" k
            WHERE k."installationId" = ${installationId} AND k."isDefaultBranch"
            ORDER BY k."projectId", k."definitionId", k."queuedAt" DESC)
        LIMIT ${BATCH}
      ), jobs AS (
        DELETE FROM "AzureBuildJob" j USING doomed d
        WHERE j."installationId" = ${installationId} AND j."buildId" = d."id"
      )
      DELETE FROM "AzureBuild" b USING doomed d
      WHERE b."installationId" = ${installationId} AND b."id" = d."id"`,
  );
  await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "AzureJobRequest" WHERE ctid IN (
        SELECT ctid FROM "AzureJobRequest"
        WHERE "installationId" = ${installationId}
          AND "queueTime" < ${new Date(deadline.now() - Math.max(retentionDays, 35) * DAY_MS)}
        LIMIT ${BATCH})`,
  );
  await db.finding.deleteMany({
    where: {
      installationId,
      status: "FIXED",
      resolvedAt: { lt: new Date(deadline.now() - 90 * DAY_MS) },
    },
  });
  return { jobs, runs, samples, deployments, azureBuilds };
}

/** Tenant tables of an installation, children first; Installation goes last. */
export const PURGE_TABLES = [
  "WorkflowJob",
  "WorkflowRun",
  "RollupDirty",
  "DailyWorkflowStat",
  "DailyJobStat",
  "DailyRunnerStat",
  "RunnerSample",
  "Runner",
  "BillingUsageItem",
  "GitHubCredential",
  "SyncState",
  "InstallationRateLimit",
  "WebhookDelivery",
  "VercelDeployment",
  "VercelProject",
  "DailyDeploymentStat",
  "Finding",
  "FeatureAvailability",
  "VercelConnection",
  "AzureBuildJob",
  "AzureBuild",
  "AzurePipelineDefinition",
  "AzureDevOpsProject",
  "AzureAgent",
  "AzurePoolSample",
  "AzurePool",
  "AzureJobRequest",
  "DailyAzureUsage",
  "AzureUsageSnapshot",
  "AzureHookSubscription",
  "PipelineRollupDirty",
  "DailyPipelineStat",
  "AzureDevOpsConnection",
  "Repository",
] as const;

/**
 * Deletes every row of an installation (uninstalled and past purgeAfter),
 * table by table in batches of 5,000 rows, checking the deadline between
 * batches. The Installation row is deleted only once every child table is
 * empty, so a purge cut off by the deadline resumes on the next tick.
 * Returns true when the installation is gone.
 */
export async function purgeInstallation(
  installationId: bigint,
  deadline: Deadline,
): Promise<boolean> {
  for (const table of PURGE_TABLES) {
    for (;;) {
      if (deadline.expired()) return false;
      // Tables with composite keys have no single id column; ctid is the
      // physical row id, stable within the statement.
      const n = await db.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE ctid IN (
           SELECT ctid FROM "${table}" WHERE "installationId" = $1::bigint LIMIT ${BATCH})`,
        installationId,
      );
      if (n < BATCH) break;
    }
  }
  if (deadline.expired()) return false;
  await db.installation.deleteMany({ where: { id: installationId } });
  return true;
}

/** Instance-wide part of the daily prune; runs at most once a day. */
export async function pruneGlobal(deadline: Deadline): Promise<boolean> {
  const now = deadline.now();
  const state = await db.appState.findUnique({
    where: { key: GLOBAL_PRUNE_KEY },
  });
  const last = Date.parse(String((state?.value as { at?: string })?.at ?? ""));
  if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) return false;

  await deleteInBatches(
    deadline,
    () =>
      db.$executeRaw`
      DELETE FROM "WebhookDelivery" WHERE "id" IN (
        SELECT "id" FROM "WebhookDelivery"
        WHERE "receivedAt" < ${new Date(now - 14 * DAY_MS)}
        LIMIT ${BATCH})`,
  );
  await db.$executeRaw`
    UPDATE "WebhookDelivery" SET "payload" = NULL
    WHERE "status" IN ('FAILED', 'DEAD') AND "payload" IS NOT NULL
      AND "receivedAt" < ${new Date(now - 7 * DAY_MS)}`;

  const purge = await db.installation.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lt: new Date(now) } },
    select: { id: true },
  });
  for (const { id } of purge) {
    if (!(await purgeInstallation(id, deadline))) break;
  }

  if (!deadline.expired()) {
    const value = { at: new Date(now).toISOString() };
    await db.appState.upsert({
      where: { key: GLOBAL_PRUNE_KEY },
      create: { key: GLOBAL_PRUNE_KEY, value },
      update: { value },
    });
  }
  return true;
}
