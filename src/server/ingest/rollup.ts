import "server-only";
import { db } from "@/server/db";
import type { Deadline } from "./budget";

/**
 * Daily rollups (design §5.5). `rollupPartition` recomputes the rows of one
 * (repository, local day) with DELETE + INSERT ... SELECT in one transaction,
 * so redeliveries, late events and backfill never double-count: a late event
 * re-marks its day and the day is recomputed from the raw rows.
 *
 * Attribution: DailyWorkflowStat counts completed runs created that day (job
 * seconds and minutes of all their attempts included); DailyJobStat counts
 * completed jobs created that day. Placeholder runs without a workflow id are
 * left out until reconcile completes them.
 */

const FAILURES = `('FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE')`;
const OTHERS = `('SKIPPED', 'NEUTRAL', 'ACTION_REQUIRED', 'STALE')`;
/** Skipped jobs (design §6.1) are excluded from duration and queue statistics. */
const NOT_SKIPPED = `NOT (j."conclusion" = 'SKIPPED' OR (j."runnerName" IS NULL AND j."startedAt" = j."completedAt"))`;

export async function rollupPartition(
  installationId: bigint,
  repositoryId: bigint,
  day: string,
  timezone: string,
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "DailyWorkflowStat"
        WHERE "installationId" = ${installationId} AND "repositoryId" = ${repositoryId} AND "day" = ${day}::date`;
      await tx.$executeRaw`
        DELETE FROM "DailyJobStat"
        WHERE "installationId" = ${installationId} AND "repositoryId" = ${repositoryId} AND "day" = ${day}::date`;

      await tx.$executeRawUnsafe(
        `
        WITH bounds AS (
          SELECT ($3::date::timestamp AT TIME ZONE $4::text) AS lo,
                 (($3::date + 1)::timestamp AT TIME ZONE $4::text) AS hi
        ),
        runs AS (
          SELECT r.* FROM "WorkflowRun" r, bounds b
          WHERE r."installationId" = $1::bigint AND r."repositoryId" = $2::bigint
            AND r."createdAt" >= b.lo AND r."createdAt" < b.hi
            AND r."statusRank" = 4 AND r."workflowId" IS NOT NULL
        ),
        per_run AS (
          SELECT r.*,
            (SELECT j1."queueS" FROM "WorkflowJob" j1
              WHERE j1."runId" = r."id" AND j1."runAttempt" = r."runAttempt"
                AND j1."queueS" IS NOT NULL
              ORDER BY j1."startedAt" ASC, j1."id" ASC LIMIT 1) AS first_queue,
            js.linux, js.windows, js.macos, js.self_hosted, js.minutes
          FROM runs r
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(sum(j."durationS") FILTER (WHERE j."runnerKind" <> 'SELF_HOSTED' AND j."runnerOs" = 'LINUX'), 0) AS linux,
              COALESCE(sum(j."durationS") FILTER (WHERE j."runnerKind" <> 'SELF_HOSTED' AND j."runnerOs" = 'WINDOWS'), 0) AS windows,
              COALESCE(sum(j."durationS") FILTER (WHERE j."runnerKind" <> 'SELF_HOSTED' AND j."runnerOs" = 'MACOS'), 0) AS macos,
              COALESCE(sum(j."durationS") FILTER (WHERE j."runnerKind" = 'SELF_HOSTED'), 0) AS self_hosted,
              COALESCE(sum(j."billableMinEst"), 0) AS minutes
            FROM "WorkflowJob" j WHERE j."runId" = r."id"
          ) js ON true
        )
        INSERT INTO "DailyWorkflowStat" (
          "installationId", "repositoryId", "workflowId", "workflowName", "day", "defaultBranch",
          "runs", "success", "failure", "cancelled", "other", "firstTrySuccess", "flakyRecovered",
          "durSumS", "durHist", "queueHist",
          "jobSecondsLinux", "jobSecondsWindows", "jobSecondsMacos", "jobSecondsSelfHosted", "billableMinEst")
        SELECT $1::bigint, $2::bigint, p."workflowId", max(p."workflowName"), $3::date, p."isDefaultBranch",
          count(*)::int,
          count(*) FILTER (WHERE p."conclusion" = 'SUCCESS')::int,
          count(*) FILTER (WHERE p."conclusion" IN ${FAILURES})::int,
          count(*) FILTER (WHERE p."conclusion" = 'CANCELLED')::int,
          count(*) FILTER (WHERE p."conclusion" IN ${OTHERS})::int,
          count(*) FILTER (WHERE p."firstAttemptConclusion" = 'SUCCESS'
            AND (p."conclusion" = 'SUCCESS' OR p."conclusion" IN ${FAILURES}))::int,
          count(*) FILTER (WHERE p."runAttempt" > 1 AND p."firstAttemptConclusion" IN ${FAILURES}
            AND p."conclusion" = 'SUCCESS')::int,
          COALESCE(sum(p."durationS"), 0)::bigint,
          hist_agg(p."durationS"),
          hist_agg(p.first_queue),
          sum(p.linux)::int, sum(p.windows)::int, sum(p.macos)::int, sum(p.self_hosted)::int,
          sum(p.minutes)::int
        FROM per_run p
        GROUP BY p."workflowId", p."isDefaultBranch"`,
        installationId,
        repositoryId,
        day,
        timezone,
      );

      await tx.$executeRawUnsafe(
        `
        WITH bounds AS (
          SELECT ($3::date::timestamp AT TIME ZONE $4::text) AS lo,
                 (($3::date + 1)::timestamp AT TIME ZONE $4::text) AS hi
        )
        INSERT INTO "DailyJobStat" (
          "installationId", "repositoryId", "workflowId", "baseName", "labelKey", "runnerKind", "day",
          "jobs", "success", "failure", "durSumS", "durHist", "queueHist", "billableMinEst")
        SELECT $1::bigint, $2::bigint, COALESCE(j."workflowId", r."workflowId") AS wf, j."baseName", j."labelKey", j."runnerKind", $3::date,
          count(*)::int,
          count(*) FILTER (WHERE j."conclusion" = 'SUCCESS')::int,
          count(*) FILTER (WHERE j."conclusion" IN ${FAILURES})::int,
          COALESCE(sum(j."durationS") FILTER (WHERE ${NOT_SKIPPED}), 0)::bigint,
          hist_agg(j."durationS") FILTER (WHERE ${NOT_SKIPPED}),
          hist_agg(j."queueS") FILTER (WHERE ${NOT_SKIPPED}),
          COALESCE(sum(j."billableMinEst"), 0)::int
        FROM "WorkflowJob" j
        LEFT JOIN "WorkflowRun" r ON r."id" = j."runId"
        CROSS JOIN bounds b
        WHERE j."installationId" = $1::bigint AND j."repositoryId" = $2::bigint
          AND j."createdAt" >= b.lo AND j."createdAt" < b.hi
          AND j."statusRank" = 4
          AND COALESCE(j."workflowId", r."workflowId") IS NOT NULL
        GROUP BY wf, j."baseName", j."labelKey", j."runnerKind"`,
        installationId,
        repositoryId,
        day,
        timezone,
      );
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

/**
 * Marks today and the previous two days dirty for every repository with
 * runs in that period (late completions, reconcile corrections).
 */
export async function markRecentDaysDirty(
  installationId: bigint,
  timezone: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "RollupDirty" ("installationId", "repositoryId", "day", "markedAt")
    SELECT DISTINCT r."installationId", r."repositoryId", d.day, now()
    FROM "WorkflowRun" r
    CROSS JOIN LATERAL (
      SELECT ((now() AT TIME ZONE ${timezone}::text)::date - g) AS day
      FROM generate_series(0, 2) AS g
    ) d
    WHERE r."installationId" = ${installationId}
      AND r."createdAt" >= now() - interval '3 days'
    ON CONFLICT ("installationId", "repositoryId", "day") DO UPDATE SET "markedAt" = now()`;
}

/** Marks every day in raw retention dirty (after a timezone change). */
export async function markAllDaysDirty(
  installationId: bigint,
  timezone: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "RollupDirty" ("installationId", "repositoryId", "day", "markedAt")
    SELECT DISTINCT r."installationId", r."repositoryId", (r."createdAt" AT TIME ZONE ${timezone}::text)::date, now()
    FROM "WorkflowRun" r WHERE r."installationId" = ${installationId}
    ON CONFLICT ("installationId", "repositoryId", "day") DO UPDATE SET "markedAt" = now()`;
  await db.$executeRaw`
    INSERT INTO "RollupDirty" ("installationId", "repositoryId", "day", "markedAt")
    SELECT DISTINCT j."installationId", j."repositoryId", (j."createdAt" AT TIME ZONE ${timezone}::text)::date, now()
    FROM "WorkflowJob" j WHERE j."installationId" = ${installationId}
    ON CONFLICT ("installationId", "repositoryId", "day") DO UPDATE SET "markedAt" = now()`;
}

export type DrainResult = { partitions: number; remaining: boolean };

/**
 * Recomputes up to `limit` dirty partitions of an installation, oldest mark
 * first. A partition re-marked while it was being recomputed stays dirty.
 */
export async function drainRollups(
  installationId: bigint,
  timezone: string,
  deadline: Deadline,
  limit = 200,
): Promise<DrainResult> {
  const dirty = await db.rollupDirty.findMany({
    where: { installationId },
    orderBy: { markedAt: "asc" },
    take: limit + 1,
  });
  let partitions = 0;
  for (const row of dirty.slice(0, limit)) {
    if (deadline.expired()) return { partitions, remaining: true };
    const day = row.day.toISOString().slice(0, 10);
    await rollupPartition(installationId, row.repositoryId, day, timezone);
    await db.rollupDirty.deleteMany({
      where: {
        installationId,
        repositoryId: row.repositoryId,
        day: row.day,
        markedAt: { lte: row.markedAt },
      },
    });
    partitions++;
  }
  return { partitions, remaining: dirty.length > limit };
}
