import "server-only";
import type { RunnerKind } from "@/generated/prisma/client";
import { db } from "@/server/db";
import {
  isSelfHostedKey,
  jobRunnerKeyResolver,
  runnerStatKey,
} from "@/server/metrics/classify";
import { histogramOf } from "@/server/metrics/histogram";
import {
  busySeconds,
  isInfraFailure,
  jobInterval,
  onlineSeconds,
  peakConcurrency,
  speedIndex,
  type Interval,
  type SampleRow,
} from "@/server/metrics/runners";
import type { Conclusion } from "@/server/metrics/stats";
import type { Deadline } from "./budget";
import { compareCodeUnits } from "@/lib/compare";

/**
 * DailyRunnerStat (design §5.5, §6.5): one row per (installation, runnerKey,
 * local day), recomputed with DELETE + INSERT in one transaction like the
 * other rollups, so late events and new samples never double-count.
 *
 * runnerKey is "shr:<repositoryId>:<runnerName>" for repo-level runners
 * (GitHub runner names are unique per repository only), "sh:<runnerName>"
 * for org runners and self-hosted runners not in the cache, and
 * "pool:<labelKey>" for hosted pools. Jobs, failures and histograms count the
 * jobs that started that day; busyS and the peak use the overlap of every job
 * with the day; onlineS (self-hosted only) is the union of online sample
 * intervals and job intervals inside the day.
 *
 * `keepOnline` recomputes only the job-derived fields of a day whose runner
 * samples are already pruned (older than SAMPLE_RETENTION_DAYS): the stored
 * onlineS of each self-hosted row is kept, and a row that only had online
 * time stays. The ignore purge uses it for the days between the sample and
 * the raw retention.
 */

export type RunnerDayOptions = { keepOnline?: boolean };

const FAILURES = new Set<Conclusion>([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
]);

type JobRow = {
  repositoryId: bigint;
  workflowId: bigint | null;
  baseName: string;
  labelKey: string;
  runnerName: string | null;
  runnerKind: RunnerKind;
  conclusion: Conclusion | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationS: number | null;
  queueS: number | null;
};

export async function rollupRunnerDay(
  installationId: bigint,
  day: string,
  timezone: string,
  opts: RunnerDayOptions = {},
): Promise<number> {
  const dayDate = new Date(`${day}T00:00:00.000Z`);
  const [bounds] = await db.$queryRaw<Array<{ lo: Date; hi: Date }>>`
    SELECT (${day}::date::timestamp AT TIME ZONE ${timezone}::text) AS lo,
           ((${day}::date + 1)::timestamp AT TIME ZONE ${timezone}::text) AS hi`;
  const lo = bounds!.lo.getTime();
  const hi = bounds!.hi.getTime();
  const w = { from: lo, to: hi };

  const jobs = await db.$queryRaw<JobRow[]>`
    SELECT j."repositoryId", j."workflowId", j."baseName", j."labelKey", j."runnerName",
      j."runnerKind", j."conclusion"::text AS conclusion, j."startedAt", j."completedAt",
      j."durationS", j."queueS"
    FROM "WorkflowJob" j
    WHERE j."installationId" = ${installationId}
      AND j."statusRank" = 4 AND j."startedAt" IS NOT NULL
      AND j."startedAt" < ${bounds!.hi} AND j."completedAt" > ${bounds!.lo}
      AND j."conclusion" IS DISTINCT FROM 'SKIPPED'
      AND NOT (j."runnerName" IS NULL AND j."startedAt" = j."completedAt")`;

  const runners = await db.runner.findMany({
    where: { installationId },
    select: {
      key: true,
      scope: true,
      repositoryId: true,
      name: true,
      removedAt: true,
    },
  });
  // Samples within the day, plus the first one after it (its interval reaches back).
  const samples = opts.keepOnline
    ? []
    : await db.runnerSample.findMany({
        where: {
          installationId,
          sampledAt: { gt: bounds!.lo, lte: new Date(hi + 86_400_000) },
        },
        orderBy: { sampledAt: "asc" },
      });
  // keepOnline: the stored online time per self-hosted stat key.
  const storedOnline = new Map<string, { kind: RunnerKind; onlineS: bigint }>();
  if (opts.keepOnline)
    for (const r of await db.dailyRunnerStat.findMany({
      where: { installationId, day: dayDate, onlineS: { not: null } },
      select: { runnerKey: true, runnerKind: true, onlineS: true },
    }))
      storedOnline.set(r.runnerKey, {
        kind: r.runnerKind,
        onlineS: r.onlineS!,
      });
  // Runner cache key -> stat key (repo runners by repository and name).
  const statKeyOf = new Map(runners.map((r) => [r.key, runnerStatKey(r)]));
  const removedAt = new Map<string, Date | null>();
  for (const r of runners) {
    // A live runner with that stat key wins; otherwise the latest removal counts.
    const k = runnerStatKey(r);
    const prev = removedAt.get(k);
    if (prev === null) continue;
    if (r.removedAt == null || prev === undefined || r.removedAt > prev)
      removedAt.set(k, r.removedAt);
  }
  const samplesBy = new Map<string, SampleRow[]>();
  for (const s of samples) {
    const key = statKeyOf.get(s.runnerKey);
    if (!key) continue;
    const list = samplesBy.get(key) ?? [];
    list.push(s);
    samplesBy.set(key, list);
  }

  type Acc = { kind: RunnerKind; jobs: JobRow[]; started: JobRow[] };
  const acc = new Map<string, Acc>();
  const keyOf = jobRunnerKeyResolver(runners);
  const keyed = jobs.map((j) => ({ ...j, runnerKey: keyOf(j) }));
  for (const j of keyed) {
    const a = acc.get(j.runnerKey) ?? {
      kind: j.runnerKind,
      jobs: [],
      started: [],
    };
    a.jobs.push(j);
    if (j.startedAt!.getTime() >= lo && j.startedAt!.getTime() < hi)
      a.started.push(j);
    acc.set(j.runnerKey, a);
  }
  // A self-hosted runner that was online without running a job still gets a row.
  for (const key of samplesBy.keys())
    if (!acc.has(key))
      acc.set(key, { kind: "SELF_HOSTED", jobs: [], started: [] });
  for (const [key, stored] of storedOnline)
    if (!acc.has(key) && stored.onlineS > 0n)
      acc.set(key, { kind: stored.kind, jobs: [], started: [] });

  const startedAll = keyed.filter(
    (j) => j.startedAt!.getTime() >= lo && j.startedAt!.getTime() < hi,
  );
  const rows = [...acc.entries()].map(([runnerKey, a]) => {
    const selfHosted = isSelfHostedKey(runnerKey);
    const intervals = a.jobs
      .map((j) => jobInterval(j, hi))
      .filter((i): i is Interval => i !== null)
      .map((i) => ({ start: Math.max(i.start, lo), end: Math.min(i.end, hi) }))
      .filter((i) => i.end > i.start);
    const stored = storedOnline.get(runnerKey);
    const online = !selfHosted
      ? null
      : stored
        ? Number(stored.onlineS)
        : Math.round(
            onlineSeconds(samplesBy.get(runnerKey) ?? [], a.jobs, w, hi),
          );
    const removed = selfHosted ? (removedAt.get(runnerKey) ?? null) : null;
    return {
      installationId,
      runnerKey,
      runnerKind: a.kind,
      day: dayDate,
      jobs: a.started.length,
      failures: a.started.filter(
        (j) => j.conclusion && FAILURES.has(j.conclusion),
      ).length,
      infraFailures: a.started.filter((j) => isInfraFailure(j, removed)).length,
      busyS: BigInt(Math.round(busySeconds(a.jobs, w, hi))),
      onlineS: online == null ? null : BigInt(online),
      peakConcurrency: peakConcurrency(intervals),
      durHist: histogramOf(
        a.started.map((j) => j.durationS).filter((v): v is number => v != null),
      ),
      queueHist: histogramOf(
        a.started.map((j) => j.queueS).filter((v): v is number => v != null),
      ),
      speedIndex: selfHosted ? speedIndex(startedAll, runnerKey) : null,
    };
  });

  // Sample-only rows (a runner online without jobs) are kept only with online time.
  const kept = rows.filter(
    (r) => r.jobs > 0 || r.busyS > 0n || (r.onlineS ?? 0n) > 0n,
  );

  await db.$transaction([
    db.dailyRunnerStat.deleteMany({
      where: { installationId, day: dayDate },
    }),
    db.dailyRunnerStat.createMany({ data: kept }),
  ]);
  return kept.length;
}

/** Recomputes the runner stats of several local days, stopping at the deadline. */
export async function rollupRunnerDays(
  installationId: bigint,
  days: Iterable<string>,
  timezone: string,
  deadline: Deadline,
  opts: RunnerDayOptions = {},
): Promise<number> {
  let done = 0;
  for (const day of [...new Set(days)].sort(compareCodeUnits)) {
    if (deadline.expired(5_000)) break;
    await rollupRunnerDay(installationId, day, timezone, opts);
    done++;
  }
  return done;
}
