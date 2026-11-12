import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { localDay } from "@/server/metrics/days";
import type { Deadline } from "./budget";
import { SAMPLE_RETENTION_DAYS } from "./prune";
import { rollupRunnerDays } from "./runner-rollup";

/**
 * Reconcile step j) purge of ignored repositories (UI overhaul §3.3).
 *
 * For every repository with `ignoredAt` set and `ignorePurgedAt` null, the
 * stored data is deleted in batches of 5,000 rows (ctid, like
 * `purgeInstallation`): jobs, runs, daily workflow and job stats, dirty
 * marks, the sync state, the repo-level runners with their samples and
 * their `shr:<repoId>:*` runner stats. `BillingUsageItem` is kept: it is
 * GitHub's bill and feeds the "Ignored repositories" cost row.
 *
 * Org runner and hosted pool stats (`sh:*`, `pool:*`) span repositories, so
 * the local days on which the repo's jobs ran are collected before the jobs
 * go (persisted in AppState, so a purge cut off by the deadline does not
 * lose them) and recomputed afterwards without the repo: fully inside the
 * runner sample retention (30 days), and beyond it, up to the raw
 * retention, only the job-derived fields (jobs, failures, busy time, peak,
 * histograms) with the stored online time kept, because the samples are
 * gone. Days older than the raw retention are left as they are: their jobs
 * are already pruned, and a recompute would lose the other repos' figures.
 *
 * The step is resumable: it checks the deadline between batches and
 * re-checks `ignoredAt` before every batch, so an un-ignore while a purge is
 * running stops it. `ignorePurgedAt` is set once every table is empty.
 */

const BATCH = 5_000;
const DAY_MS = 86_400_000;

/** Tables keyed by `repositoryId`, children first. */
const REPO_TABLES = [
  "WorkflowJob",
  "WorkflowRun",
  "DailyWorkflowStat",
  "DailyJobStat",
  "RollupDirty",
  "SyncState",
] as const;

export type IgnorePurgeResult = {
  /** Repositories whose purge finished in this pass. */
  purged: number;
  /** Repositories still waiting (deadline). */
  remaining: number;
  rows: number;
  runnerDays: number;
};

const daysKey = (repositoryId: bigint) => `ignore-purge-days:${repositoryId}`;

async function stillIgnored(repositoryId: bigint): Promise<boolean> {
  const repo = await db.repository.findUnique({
    where: { id: repositoryId },
    select: { ignoredAt: true },
  });
  return repo?.ignoredAt != null;
}

/** Local days of the repo's jobs (from `oldest` on), merged into the persisted set. */
async function collectDays(
  installationId: bigint,
  repositoryId: bigint,
  timezone: string,
  oldest: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ day: string }>>`
    SELECT DISTINCT to_char((COALESCE(j."startedAt", j."createdAt") AT TIME ZONE ${timezone}::text)::date, 'YYYY-MM-DD') AS day
    FROM "WorkflowJob" j
    WHERE j."installationId" = ${installationId} AND j."repositoryId" = ${repositoryId}`;
  const key = daysKey(repositoryId);
  const stored = await db.appState.findUnique({ where: { key } });
  const before = Array.isArray((stored?.value as { days?: unknown })?.days)
    ? ((stored!.value as { days: unknown[] }).days.filter(
        (d) => typeof d === "string",
      ) as string[])
    : [];
  const days = [
    ...new Set([
      ...before,
      ...rows.map((r) => r.day).filter((d) => d >= oldest),
    ]),
  ].sort();
  const value = { days };
  await db.appState.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  return days;
}

async function deleteBatch(sql: Prisma.Sql): Promise<number> {
  return db.$executeRaw(sql);
}

/**
 * Deletes the stored data of one ignored repository. Returns "done", "stopped"
 * (deadline or un-ignored) and the number of deleted rows.
 */
async function purgeRepository(
  installationId: bigint,
  repositoryId: bigint,
  timezone: string,
  window: { rawOldestDay: string; sampleOldestDay: string },
  deadline: Deadline,
): Promise<{ state: "done" | "stopped"; rows: number; runnerDays: number }> {
  let rows = 0;
  const days = await collectDays(
    installationId,
    repositoryId,
    timezone,
    window.rawOldestDay,
  );

  const loop = async (sql: () => Prisma.Sql): Promise<boolean> => {
    for (;;) {
      if (deadline.expired(5_000)) return false;
      if (!(await stillIgnored(repositoryId))) return false;
      const n = await deleteBatch(sql());
      rows += n;
      if (n < BATCH) return true;
    }
  };

  for (const table of REPO_TABLES) {
    const t = Prisma.raw(`"${table}"`);
    const ok = await loop(
      () => Prisma.sql`
        DELETE FROM ${t} WHERE ctid IN (
          SELECT ctid FROM ${t}
          WHERE "installationId" = ${installationId} AND "repositoryId" = ${repositoryId}
          LIMIT ${BATCH})`,
    );
    if (!ok) return { state: "stopped", rows, runnerDays: 0 };
  }

  // Repo-level runners, their samples and their runner stats.
  const runners = await db.runner.findMany({
    where: { installationId, scope: "REPO", repositoryId },
    select: { key: true },
  });
  const keys = runners.map((r) => r.key);
  if (keys.length > 0) {
    const ok = await loop(
      () => Prisma.sql`
        DELETE FROM "RunnerSample" WHERE ctid IN (
          SELECT ctid FROM "RunnerSample"
          WHERE "installationId" = ${installationId} AND "runnerKey" IN (${Prisma.join(keys)})
          LIMIT ${BATCH})`,
    );
    if (!ok) return { state: "stopped", rows, runnerDays: 0 };
  }
  const prefix = `shr:${repositoryId}:%`;
  const okStats = await loop(
    () => Prisma.sql`
      DELETE FROM "DailyRunnerStat" WHERE ctid IN (
        SELECT ctid FROM "DailyRunnerStat"
        WHERE "installationId" = ${installationId} AND "runnerKey" LIKE ${prefix}
        LIMIT ${BATCH})`,
  );
  if (!okStats) return { state: "stopped", rows, runnerDays: 0 };
  if (!(await stillIgnored(repositoryId)))
    return { state: "stopped", rows, runnerDays: 0 };
  rows += (
    await db.runner.deleteMany({
      where: { installationId, scope: "REPO", repositoryId },
    })
  ).count;

  // Org runner and hosted pool stats of the affected days, without the repo:
  // days with samples fully, older ones with their stored online time.
  const recent = days.filter((d) => d >= window.sampleOldestDay);
  const older = days.filter((d) => d < window.sampleOldestDay);
  let runnerDays = await rollupRunnerDays(
    installationId,
    recent,
    timezone,
    deadline,
  );
  if (runnerDays === recent.length)
    runnerDays += await rollupRunnerDays(
      installationId,
      older,
      timezone,
      deadline,
      { keepOnline: true },
    );
  if (runnerDays < days.length) return { state: "stopped", rows, runnerDays };

  const { count } = await db.repository.updateMany({
    where: { id: repositoryId, installationId, ignoredAt: { not: null } },
    data: { ignorePurgedAt: new Date(deadline.now()) },
  });
  await db.appState.deleteMany({ where: { key: daysKey(repositoryId) } });
  return { state: count === 1 ? "done" : "stopped", rows, runnerDays };
}

/** Purges every ignored, not yet purged repository of an installation. */
export async function purgeIgnoredRepositories(
  installationId: bigint,
  timezone: string,
  retentionDays: number | null,
  deadline: Deadline,
): Promise<IgnorePurgeResult> {
  const result: IgnorePurgeResult = {
    purged: 0,
    remaining: 0,
    rows: 0,
    runnerDays: 0,
  };
  const pending = await db.repository.findMany({
    where: { installationId, ignoredAt: { not: null }, ignorePurgedAt: null },
    orderBy: { ignoredAt: "asc" },
    select: { id: true },
  });
  if (pending.length === 0) return result;
  const now = deadline.now();
  const oldest = (keepDays: number) =>
    localDay(new Date(now - (keepDays - 1) * DAY_MS), timezone);
  const window = {
    // Without a raw retention every stored day still has its jobs.
    rawOldestDay: retentionDays == null ? "0000-01-01" : oldest(retentionDays),
    sampleOldestDay: oldest(
      Math.min(SAMPLE_RETENTION_DAYS, retentionDays ?? Infinity),
    ),
  };

  for (const [i, repo] of pending.entries()) {
    if (deadline.expired(5_000)) {
      result.remaining += pending.length - i;
      break;
    }
    const r = await purgeRepository(
      installationId,
      repo.id,
      timezone,
      window,
      deadline,
    );
    result.rows += r.rows;
    result.runnerDays += r.runnerDays;
    if (r.state === "done") result.purged++;
    else if (await stillIgnored(repo.id)) result.remaining++;
  }
  return result;
}

/** Forgets the collected runner days of a repository (un-ignore). */
export async function forgetPurgeDays(repositoryId: bigint): Promise<void> {
  await db.appState.deleteMany({ where: { key: daysKey(repositoryId) } });
}
