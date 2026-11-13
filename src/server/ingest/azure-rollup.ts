import "server-only";
import { db } from "@/server/db";
import type { Deadline } from "./budget";

/**
 * Daily pipeline stats (design addendum M7 §2.2, §4.3 z7): DailyPipelineStat
 * per (project, definition, local day, branch class), recomputed with
 * DELETE + INSERT … SELECT per installation day, so retries, late
 * timelines and backfill never double-count. The histograms use the same
 * SQL helpers as DailyWorkflowStat (`hist_agg`), so stats.ts and
 * histogram.ts read both the same way; a parity test pins it.
 *
 * Buckets: succeeded, partial (partiallySucceeded, amber, not a success),
 * failed, canceled and timedOut (a job hit the cap; counted only there).
 * The success-rate denominator is succeeded + failed + partial + timedOut,
 * like GitHub's success + failure (+ timed out). First try: attempt 1
 * succeeded and the build counts in the denominator; flaky-recovered:
 * attempt 1 failed (or partial) and a later attempt succeeded.
 */

export async function rollupPipelineDays(
  installationId: bigint,
  timezone: string,
  days: ReadonlyArray<string>,
): Promise<void> {
  const list = [...new Set(days)]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (list.length === 0) return;
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "DailyPipelineStat"
        WHERE "installationId" = ${installationId} AND "day" = ANY(${list}::date[])`;
      await tx.$executeRawUnsafe(
        `
        WITH conn AS (
          SELECT COALESCE((SELECT c."maxJobMinutes" FROM "AzureDevOpsConnection" c
                            WHERE c."installationId" = $1::bigint), 60) AS cap
        ),
        builds AS (
          SELECT b.*, (b."queuedAt" AT TIME ZONE $3::text)::date AS day
          FROM "AzureBuild" b
          WHERE b."installationId" = $1::bigint AND b."status" = 'COMPLETED'
            AND (b."queuedAt" AT TIME ZONE $3::text)::date = ANY($2::date[])
        ),
        per AS (
          SELECT b.*, js.linux, js.windows, js.macos, js.self_hosted, js.near_cap
          FROM builds b
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(sum(j."durationS") FILTER (WHERE j."isHosted" IS TRUE AND j."os" = 'LINUX'), 0) AS linux,
              COALESCE(sum(j."durationS") FILTER (WHERE j."isHosted" IS TRUE AND j."os" = 'WINDOWS'), 0) AS windows,
              COALESCE(sum(j."durationS") FILTER (WHERE j."isHosted" IS TRUE AND j."os" = 'MACOS'), 0) AS macos,
              COALESCE(sum(j."durationS") FILTER (WHERE j."isHosted" IS NOT TRUE), 0) AS self_hosted,
              count(*) FILTER (WHERE j."hitJobCap" OR j."durationS" >= ((SELECT cap FROM conn) * 60 - 600)) AS near_cap
            FROM "AzureBuildJob" j
            WHERE j."installationId" = b."installationId" AND j."buildId" = b."id" AND j."type" = 'Job'
          ) js ON true
        )
        INSERT INTO "DailyPipelineStat" (
          "installationId", "projectId", "definitionId", "day", "defaultBranch", "repositoryId",
          "builds", "succeeded", "partial", "failed", "canceled", "timedOut",
          "firstTrySuccess", "flakyRecovered", "durSumS", "durationHist", "queueHist",
          "jobSecondsHostedLinux", "jobSecondsHostedWindows", "jobSecondsHostedMacos",
          "jobSecondsSelfHosted", "jobsNearCap")
        SELECT $1::bigint, p."projectId", p."definitionId", p.day, p."isDefaultBranch", max(p."repositoryId"),
          count(*)::int,
          count(*) FILTER (WHERE p."result" = 'SUCCEEDED' AND NOT p."timedOut")::int,
          count(*) FILTER (WHERE p."result" = 'PARTIALLY_SUCCEEDED' AND NOT p."timedOut")::int,
          count(*) FILTER (WHERE p."result" = 'FAILED' AND NOT p."timedOut")::int,
          count(*) FILTER (WHERE p."result" IN ('CANCELED', 'NONE') AND NOT p."timedOut")::int,
          count(*) FILTER (WHERE p."timedOut")::int,
          count(*) FILTER (WHERE p."firstAttemptResult" = 'SUCCEEDED'
            AND (p."timedOut" OR p."result" IN ('SUCCEEDED', 'FAILED', 'PARTIALLY_SUCCEEDED')))::int,
          count(*) FILTER (WHERE p."maxAttempt" > 1
            AND p."firstAttemptResult" IN ('FAILED', 'PARTIALLY_SUCCEEDED')
            AND p."result" = 'SUCCEEDED' AND NOT p."timedOut")::int,
          COALESCE(sum(p."durationS"), 0)::bigint,
          hist_agg(p."durationS"),
          hist_agg(p."queueS"),
          sum(p.linux)::int, sum(p.windows)::int, sum(p.macos)::int, sum(p.self_hosted)::int,
          sum(p.near_cap)::int
        FROM per p
        GROUP BY p."projectId", p."definitionId", p.day, p."isDefaultBranch"`,
        installationId,
        list,
        timezone,
      );
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

/** Marks local days dirty (hints, actions, ignore purges outside the step). */
export async function markPipelineDaysDirty(
  installationId: bigint,
  days: ReadonlyArray<string>,
  now: Date,
): Promise<void> {
  const list = [...new Set(days)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (list.length === 0) return;
  await db.$executeRaw`
    INSERT INTO "PipelineRollupDirty" ("installationId", "day", "markedAt")
    SELECT ${installationId}, d::date, ${now} FROM unnest(${list}::text[]) AS d
    ON CONFLICT ("installationId", "day") DO UPDATE SET "markedAt" = EXCLUDED."markedAt"`;
}

const DAY_MS = 86_400_000;

/**
 * Recomputes the dirty days plus `extra` (days the step touched). Days
 * older than the raw retention keep their stats: their builds may already
 * be pruned (same rule as the GitHub drain).
 */
export async function drainPipelineRollups(
  installationId: bigint,
  timezone: string,
  extra: ReadonlyArray<string>,
  retentionDays: number | null,
  deadline: Deadline,
): Promise<number> {
  const marks = await db.pipelineRollupDirty.findMany({
    where: { installationId },
    orderBy: { markedAt: "asc" },
    take: 200,
    select: { day: true, markedAt: true },
  });
  const cutoff =
    retentionDays == null
      ? null
      : new Date(deadline.now() - retentionDays * DAY_MS + 3_600_000)
          .toISOString()
          .slice(0, 10);
  const days = [
    ...new Set([
      ...extra,
      ...marks.map((m) => m.day.toISOString().slice(0, 10)),
    ]),
  ].filter((d) => !cutoff || d >= cutoff);
  const done = new Set<string>();
  for (let i = 0; i < days.length; i += 31) {
    if (deadline.expired()) break;
    const chunk = days.slice(i, i + 31);
    await rollupPipelineDays(installationId, timezone, chunk);
    for (const d of chunk) done.add(d);
  }
  for (const m of marks) {
    const day = m.day.toISOString().slice(0, 10);
    // Done, or older than the retention (its stats stay as they are).
    if (!done.has(day) && (!cutoff || day >= cutoff)) continue;
    await db.pipelineRollupDirty.deleteMany({
      where: { installationId, day: m.day, markedAt: { lte: m.markedAt } },
    });
  }
  return done.size;
}
