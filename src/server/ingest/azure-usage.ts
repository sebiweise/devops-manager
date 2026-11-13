import "server-only";
import { billingMonth, sweepIntervals, type Interval } from "@/lib/azure-usage";
import { jobMinutes } from "@/server/azure/map";
import { db } from "@/server/db";
import { localDay, startOfLocalDay } from "@/server/metrics/days";

/**
 * Hosted usage of an organisation (design addendum M7 §2.2, §5.2), DB only:
 *
 * - DailyAzureUsage per local day from the org-wide hosted job requests
 *   (every project, linked or not, because that is what the free tier
 *   counts): minutes per job rounded up (verify), private versus public,
 *   the OS split, the peak of parallel jobs and the seconds every parallel
 *   job was busy (sweep over assign → finish), jobs that waited more than
 *   10 minutes and the queue time caused by saturation.
 * - Without the job request feed (preview route unavailable) the same is
 *   estimated from the synced hosted job rows and labelled `builds`
 *   (partial: unlinked definitions are missing).
 * - The `estimate` snapshot of the billing month (always written; the
 *   `api` snapshot comes from resourceusage in the step).
 */

const DAY_MS = 86_400_000;

type Job = {
  queueTime: Date | null;
  assignTime: Date | null;
  finishTime: Date | null;
  isPrivate: boolean | null;
  os: "LINUX" | "WINDOWS" | "MACOS" | "UNKNOWN";
};

export async function computeDailyUsage(
  installationId: bigint,
  timezone: string,
  days: ReadonlyArray<string>,
  hostedParallelJobs: number,
  source: "jobrequests" | "builds",
): Promise<void> {
  const list = [...new Set(days)].sort();
  if (list.length === 0) return;
  const from = startOfLocalDay(list[0]!, timezone);
  const to = new Date(
    startOfLocalDay(list[list.length - 1]!, timezone).getTime() +
      DAY_MS +
      3 * 3_600_000,
  );
  const lookback = new Date(from.getTime() - 6 * 3_600_000);
  let jobs: Job[];
  if (source === "jobrequests") {
    jobs = await db.azureJobRequest.findMany({
      where: {
        installationId,
        isHosted: true,
        OR: [
          { assignTime: { gte: lookback, lt: to } },
          { finishTime: { gte: from, lt: to } },
          { queueTime: { gte: from, lt: to } },
        ],
      },
      select: {
        queueTime: true,
        assignTime: true,
        finishTime: true,
        isPrivate: true,
        os: true,
      },
    });
  } else {
    const rows = await db.$queryRaw<
      Array<{
        queuedAt: Date | null;
        startedAt: Date | null;
        finishedAt: Date | null;
        visibility: string | null;
        os: Job["os"];
      }>
    >`
      SELECT COALESCE(j."queuedAt", b."queuedAt") AS "queuedAt", j."startedAt", j."finishedAt",
             p."visibility", j."os"
      FROM "AzureBuildJob" j
      JOIN "AzureBuild" b ON b."installationId" = j."installationId" AND b."id" = j."buildId"
      LEFT JOIN "AzureDevOpsProject" p ON p."installationId" = j."installationId" AND p."id" = j."projectId"
      WHERE j."installationId" = ${installationId} AND j."type" = 'Job' AND j."isHosted" IS NOT FALSE
        AND j."startedAt" >= ${lookback} AND j."startedAt" < ${to}`;
    jobs = rows.map((r) => ({
      queueTime: r.queuedAt,
      assignTime: r.startedAt,
      finishTime: r.finishedAt,
      isPrivate: r.visibility == null ? null : r.visibility !== "public",
      os: r.os,
    }));
  }
  const nowMs = Date.now();
  for (const day of list) {
    const lo = startOfLocalDay(day, timezone).getTime();
    const hi = lo + DAY_MS;
    let priv = 0;
    let pub = 0;
    let mac = 0;
    let linux = 0;
    let win = 0;
    let over10 = 0;
    const intervals: Interval[] = [];
    for (const j of jobs) {
      if (j.assignTime) {
        const end = j.finishTime?.getTime() ?? Math.min(nowMs, hi);
        intervals.push({ start: j.assignTime.getTime(), end });
      }
      // Minutes and OS split count on the day the job was assigned.
      if (
        j.assignTime &&
        j.assignTime.getTime() >= lo &&
        j.assignTime.getTime() < hi
      ) {
        const min = jobMinutes(j.assignTime, j.finishTime);
        if (j.isPrivate === false) pub += min;
        else priv += min;
        if (j.os === "MACOS") mac += min;
        else if (j.os === "WINDOWS") win += min;
        else linux += min;
      }
      if (
        j.queueTime &&
        j.queueTime.getTime() >= lo &&
        j.queueTime.getTime() < hi &&
        (j.assignTime?.getTime() ?? Math.min(nowMs, hi)) -
          j.queueTime.getTime() >
          600_000
      )
        over10++;
    }
    const { peak, saturatedS } = sweepIntervals(
      intervals,
      hostedParallelJobs,
      lo,
      hi,
    );
    // Queue time caused by parallelism: waits that began while every job was busy.
    let saturationQueueS = 0;
    for (const j of jobs) {
      if (
        !j.queueTime ||
        j.queueTime.getTime() < lo ||
        j.queueTime.getTime() >= hi
      )
        continue;
      const q = j.queueTime.getTime();
      const busy = intervals.filter((i) => i.start <= q && i.end > q).length;
      if (busy >= Math.max(1, hostedParallelJobs)) {
        const waited =
          ((j.assignTime?.getTime() ?? Math.min(nowMs, hi)) - q) / 1000;
        saturationQueueS += Math.max(0, Math.round(waited));
      }
    }
    const data = {
      hostedMinutesPrivate: priv,
      hostedMinutesPublic: pub,
      hostedMinutesMacos: mac,
      hostedMinutesLinux: linux,
      hostedMinutesWindows: win,
      peakParallel: peak,
      saturatedS,
      jobsQueuedOver10m: over10,
      saturationQueueS,
      source,
    };
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    await db.dailyAzureUsage.upsert({
      where: { installationId_day: { installationId, day: dayDate } },
      create: { installationId, day: dayDate, ...data },
      update: data,
    });
  }
}

/** Today and yesterday plus the days of new job requests: what the step recomputes. */
export function usageDays(
  now: Date,
  timezone: string,
  extra: ReadonlyArray<Date> = [],
): string[] {
  return [
    ...new Set([
      localDay(now, timezone),
      localDay(new Date(now.getTime() - DAY_MS), timezone),
      ...extra.map((d) => localDay(d, timezone)),
    ]),
  ];
}

/** Private hosted minutes of the current billing month (the estimate). */
export async function estimateMonthMinutes(
  installationId: bigint,
  timezone: string,
  monthResetDay: number,
  now: Date,
): Promise<{
  month: ReturnType<typeof billingMonth>;
  minutes: number;
  macos: number;
}> {
  const month = billingMonth(localDay(now, timezone), monthResetDay);
  const rows = await db.dailyAzureUsage.aggregate({
    where: {
      installationId,
      day: {
        gte: new Date(`${month.startDay}T00:00:00Z`),
        lt: new Date(`${month.endDay}T00:00:00Z`),
      },
    },
    _sum: { hostedMinutesPrivate: true, hostedMinutesMacos: true },
  });
  return {
    month,
    minutes: rows._sum.hostedMinutesPrivate ?? 0,
    macos: rows._sum.hostedMinutesMacos ?? 0,
  };
}

export async function writeEstimateSnapshot(
  installationId: bigint,
  timezone: string,
  conn: {
    monthResetDay: number;
    includedMinutes: number | null;
    hostedParallelJobs: number;
  },
  now: Date,
): Promise<void> {
  const est = await estimateMonthMinutes(
    installationId,
    timezone,
    conn.monthResetDay,
    now,
  );
  const hosted = await db.azurePool.findMany({
    where: { installationId, isHosted: true, removedAt: null },
    select: { id: true },
  });
  const latest = await db.azurePoolSample.findFirst({
    where: { installationId, poolId: { in: hosted.map((p) => p.id) } },
    orderBy: { at: "desc" },
    select: { running: true },
  });
  const data = {
    usedMinutes: est.minutes,
    totalMinutes: conn.includedMinutes,
    usedParallel: latest?.running ?? 0,
    totalParallel: conn.hostedParallelJobs,
    isPremium: null,
    capturedAt: now,
  };
  await db.azureUsageSnapshot.upsert({
    where: {
      installationId_month_source: {
        installationId,
        month: est.month.key,
        source: "estimate",
      },
    },
    create: {
      installationId,
      month: est.month.key,
      source: "estimate",
      ...data,
    },
    update: data,
  });
}
