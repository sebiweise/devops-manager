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
 * | Installations past purgeAfter| every row of the installation                 |
 * | Daily stats                  | kept forever                                  |
 */

const BATCH = 5_000;
const DAY_MS = 86_400_000;
export const PRUNE_INTERVAL_MS = DAY_MS;
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
): Promise<{ jobs: number; runs: number }> {
  if (retentionDays == null) return { jobs: 0, runs: 0 };
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
  return { jobs, runs };
}

/** Deletes every row of an installation (uninstalled and past purgeAfter). */
export async function purgeInstallation(installationId: bigint): Promise<void> {
  await db.$transaction(
    [
      db.workflowJob.deleteMany({ where: { installationId } }),
      db.workflowRun.deleteMany({ where: { installationId } }),
      db.rollupDirty.deleteMany({ where: { installationId } }),
      db.dailyWorkflowStat.deleteMany({ where: { installationId } }),
      db.dailyJobStat.deleteMany({ where: { installationId } }),
      db.syncState.deleteMany({ where: { installationId } }),
      db.installationRateLimit.deleteMany({ where: { installationId } }),
      db.webhookDelivery.deleteMany({ where: { installationId } }),
      db.repository.deleteMany({ where: { installationId } }),
      db.installation.deleteMany({ where: { id: installationId } }),
    ],
    { timeout: 120_000 },
  );
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
    if (deadline.expired()) break;
    await purgeInstallation(id);
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
