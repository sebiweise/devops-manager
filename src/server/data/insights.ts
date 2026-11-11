import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { TenantScope } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { db } from "@/server/db";
import { daysBetween, localDay } from "@/server/metrics/days";
import {
  histogramCount,
  histogramPercentile,
  mergeHistograms,
} from "@/server/metrics/histogram";
import {
  detectFlakyJobs,
  detectRegression,
  detectSuccessDrop,
  firstTrySuccessRate,
  flakyRate,
  runTimings,
  successRate,
  trendDelta,
  type Conclusion,
  type PercentileWindow,
  type Regression,
} from "@/server/metrics/stats";
import { inScope, NotFoundError } from "./installations";

/**
 * Actions insights for the UI (design §6, §7). Every function takes a
 * `TenantScope` and an installation id; an installation outside the scope,
 * an inactive one, or a repository, workflow or run of another installation
 * throws `NotFoundError` (rendered as 404) before any data is read.
 *
 * Reads are exact (`percentile_cont` over raw rows) while the range lies
 * inside raw retention and holds fewer than 50k rows; otherwise they come
 * from the daily rollup histograms and are flagged `approx: true` (shown with
 * "~" in the UI). DTOs carry ids as strings and times as ISO strings.
 */

export const RANGES = ["24h", "7d", "30d", "90d", "12m"] as const;
export type InsightRange = (typeof RANGES)[number];

const DAY_MS = 86_400_000;
const EXACT_LIMIT = 50_000;
const FAILURES = Prisma.raw(`('FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE')`);
const OTHERS = Prisma.raw(`('SKIPPED', 'NEUTRAL', 'ACTION_REQUIRED', 'STALE')`);

export function parseRange(value: string | null | undefined): InsightRange {
  return (RANGES as readonly string[]).includes(value ?? "")
    ? (value as InsightRange)
    : "7d";
}

export function rangeStart(range: InsightRange, now: Date): Date {
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "12m": 365 }[range];
  return new Date(now.getTime() - days * DAY_MS);
}

type InstallationInfo = {
  id: bigint;
  accountLogin: string;
  timezone: string;
  rawRetentionDays: number;
  lastWebhookAt: Date | null;
  lastReconciledAt: Date | null;
};

/** The visible, active installation, or NotFoundError. */
async function visibleInstallation(
  scope: TenantScope,
  installationId: bigint,
): Promise<InstallationInfo> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: {
      id: true,
      accountLogin: true,
      timezone: true,
      rawRetentionDays: true,
      lastWebhookAt: true,
      lastReconciledAt: true,
    },
  });
  if (!inst) throw new NotFoundError();
  return inst;
}

async function visibleRepository(installationId: bigint, repositoryId: bigint) {
  const repo = await db.repository.findFirst({
    where: { id: repositoryId, installationId, removedAt: null },
    select: { id: true, fullName: true, defaultBranch: true },
  });
  if (!repo) throw new NotFoundError();
  return repo;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function insideRetention(inst: InstallationInfo, from: Date, now: Date) {
  return from.getTime() >= now.getTime() - inst.rawRetentionDays * DAY_MS;
}

// ---------- shared aggregates ----------

export type RunFilter = {
  repositoryId?: bigint;
  workflowId?: bigint;
  defaultBranchOnly?: boolean;
};

export type RunSummary = {
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  other: number;
  firstTrySuccess: number;
  flakyRecovered: number;
  successRate: number | null;
  firstTrySuccessRate: number | null;
  flakyRate: number | null;
  /** Completed runs with a duration. */
  n: number;
  p50: number | null;
  p95: number | null;
  queueP95: number | null;
  approx: boolean;
};

export type DayPoint = {
  day: string;
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  other: number;
  successRate: number | null;
  p50: number | null;
  p95: number | null;
  queueP95: number | null;
  billableMinEst: number;
};

function runWhere(installationId: bigint, f: RunFilter, from: Date, to: Date) {
  return Prisma.sql`r."installationId" = ${installationId}
    AND r."statusRank" = 4
    AND r."createdAt" >= ${from} AND r."createdAt" < ${to}
    ${f.repositoryId !== undefined ? Prisma.sql`AND r."repositoryId" = ${f.repositoryId}` : Prisma.empty}
    ${f.workflowId !== undefined ? Prisma.sql`AND r."workflowId" = ${f.workflowId}` : Prisma.empty}
    ${f.defaultBranchOnly ? Prisma.sql`AND r."isDefaultBranch"` : Prisma.empty}`;
}

function statWhere(
  installationId: bigint,
  f: RunFilter,
  fromDay: string,
  toDay: string,
) {
  return Prisma.sql`s."installationId" = ${installationId}
    AND s."day" >= ${fromDay}::date AND s."day" <= ${toDay}::date
    ${f.repositoryId !== undefined ? Prisma.sql`AND s."repositoryId" = ${f.repositoryId}` : Prisma.empty}
    ${f.workflowId !== undefined ? Prisma.sql`AND s."workflowId" = ${f.workflowId}` : Prisma.empty}
    ${f.defaultBranchOnly ? Prisma.sql`AND s."defaultBranch"` : Prisma.empty}`;
}

type CountRow = {
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  other: number;
  first_try: number;
  flaky: number;
  n: number;
  p50: number | null;
  p95: number | null;
};

const countColumns = Prisma.sql`
  count(*)::int AS runs,
  count(*) FILTER (WHERE r."conclusion" = 'SUCCESS')::int AS success,
  count(*) FILTER (WHERE r."conclusion" IN ${FAILURES})::int AS failure,
  count(*) FILTER (WHERE r."conclusion" = 'CANCELLED')::int AS cancelled,
  count(*) FILTER (WHERE r."conclusion" IN ${OTHERS})::int AS other,
  count(*) FILTER (WHERE r."firstAttemptConclusion" = 'SUCCESS'
    AND (r."conclusion" = 'SUCCESS' OR r."conclusion" IN ${FAILURES}))::int AS first_try,
  count(*) FILTER (WHERE r."runAttempt" > 1 AND r."firstAttemptConclusion" IN ${FAILURES}
    AND r."conclusion" = 'SUCCESS')::int AS flaky,
  count(r."durationS")::int AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r."durationS") AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r."durationS") AS p95`;

function summaryOf(
  c: Omit<CountRow, "first_try" | "flaky"> & {
    firstTrySuccess: number;
    flakyRecovered: number;
  },
  queueP95: number | null,
  approx: boolean,
): RunSummary {
  return {
    runs: c.runs,
    success: c.success,
    failure: c.failure,
    cancelled: c.cancelled,
    other: c.other,
    firstTrySuccess: c.firstTrySuccess,
    flakyRecovered: c.flakyRecovered,
    successRate: successRate(c),
    firstTrySuccessRate: firstTrySuccessRate(c),
    flakyRate: flakyRate(c),
    n: c.n,
    p50: c.p50 == null ? null : Number(c.p50),
    p95: c.p95 == null ? null : Number(c.p95),
    queueP95,
    approx,
  };
}

/** Exact counts and percentiles from raw rows. */
async function rawSummary(
  installationId: bigint,
  f: RunFilter,
  from: Date,
  to: Date,
): Promise<RunSummary> {
  const [row] = await db.$queryRaw<CountRow[]>`
    SELECT ${countColumns} FROM "WorkflowRun" r
    WHERE ${runWhere(installationId, f, from, to)}`;
  // Queue time per run: the first job of the latest attempt to start.
  const [queue] = await db.$queryRaw<Array<{ p95: number | null }>>`
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY q."queueS") AS p95
    FROM "WorkflowRun" r
    CROSS JOIN LATERAL (
      SELECT j."queueS" FROM "WorkflowJob" j
      WHERE j."runId" = r."id" AND j."runAttempt" = r."runAttempt" AND j."queueS" IS NOT NULL
      ORDER BY j."startedAt" ASC, j."id" ASC LIMIT 1
    ) q
    WHERE ${runWhere(installationId, f, from, to)}`;
  const c = row!;
  return summaryOf(
    { ...c, firstTrySuccess: c.first_try, flakyRecovered: c.flaky },
    queue?.p95 == null ? null : Number(queue.p95),
    false,
  );
}

type StatRow = {
  day: Date;
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  other: number;
  first_try: number;
  flaky: number;
  dur_hist: number[] | null;
  queue_hist: number[] | null;
  minutes: number;
};

async function rollupDays(
  installationId: bigint,
  f: RunFilter,
  fromDay: string,
  toDay: string,
): Promise<StatRow[]> {
  return db.$queryRaw<StatRow[]>`
    SELECT s."day",
      sum(s."runs")::int AS runs, sum(s."success")::int AS success,
      sum(s."failure")::int AS failure, sum(s."cancelled")::int AS cancelled,
      sum(s."other")::int AS other, sum(s."firstTrySuccess")::int AS first_try,
      sum(s."flakyRecovered")::int AS flaky,
      hist_sum(s."durHist") AS dur_hist, hist_sum(s."queueHist") AS queue_hist,
      sum(s."billableMinEst")::int AS minutes
    FROM "DailyWorkflowStat" s
    WHERE ${statWhere(installationId, f, fromDay, toDay)}
    GROUP BY s."day" ORDER BY s."day"`;
}

function rollupSummary(rows: StatRow[]): RunSummary {
  const sum = (k: keyof StatRow) =>
    rows.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
  const dur = mergeHistograms(...rows.map((r) => r.dur_hist));
  const queue = mergeHistograms(...rows.map((r) => r.queue_hist));
  return summaryOf(
    {
      runs: sum("runs"),
      success: sum("success"),
      failure: sum("failure"),
      cancelled: sum("cancelled"),
      other: sum("other"),
      firstTrySuccess: sum("first_try"),
      flakyRecovered: sum("flaky"),
      n: histogramCount(dur),
      p50: histogramPercentile(dur, 0.5),
      p95: histogramPercentile(dur, 0.95),
    },
    histogramPercentile(queue, 0.95),
    true,
  );
}

async function rawCount(
  installationId: bigint,
  f: RunFilter,
  from: Date,
  to: Date,
): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "WorkflowRun" r
    WHERE ${runWhere(installationId, f, from, to)}`;
  return row?.n ?? 0;
}

/** Exact while inside raw retention and below 50k rows, else from rollups. */
async function summarize(
  inst: InstallationInfo,
  f: RunFilter,
  from: Date,
  to: Date,
  now: Date,
): Promise<RunSummary> {
  if (
    insideRetention(inst, from, now) &&
    (await rawCount(inst.id, f, from, to)) < EXACT_LIMIT
  ) {
    return rawSummary(inst.id, f, from, to);
  }
  return rollupSummary(
    await rollupDays(
      inst.id,
      f,
      localDay(from, inst.timezone),
      localDay(to, inst.timezone),
    ),
  );
}

async function perDay(
  inst: InstallationInfo,
  f: RunFilter,
  from: Date,
  to: Date,
  now: Date,
): Promise<DayPoint[]> {
  const fromDay = localDay(from, inst.timezone);
  const toDay = localDay(to, inst.timezone);
  const points = new Map<string, DayPoint>();
  for (const day of daysBetween(fromDay, toDay)) {
    points.set(day, {
      day,
      runs: 0,
      success: 0,
      failure: 0,
      cancelled: 0,
      other: 0,
      successRate: null,
      p50: null,
      p95: null,
      queueP95: null,
      billableMinEst: 0,
    });
  }
  if (insideRetention(inst, from, now)) {
    const rows = await db.$queryRaw<
      Array<
        CountRow & { day: string; queue_p95: number | null; minutes: number }
      >
    >`
      SELECT to_char((r."createdAt" AT TIME ZONE ${inst.timezone}::text)::date, 'YYYY-MM-DD') AS day,
        ${countColumns},
        percentile_cont(0.95) WITHIN GROUP (ORDER BY q."queueS") AS queue_p95,
        COALESCE(sum(m.minutes), 0)::int AS minutes
      FROM "WorkflowRun" r
      LEFT JOIN LATERAL (
        SELECT j."queueS" FROM "WorkflowJob" j
        WHERE j."runId" = r."id" AND j."runAttempt" = r."runAttempt" AND j."queueS" IS NOT NULL
        ORDER BY j."startedAt" ASC, j."id" ASC LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(j."billableMinEst"), 0) AS minutes
        FROM "WorkflowJob" j WHERE j."runId" = r."id"
      ) m ON true
      WHERE ${runWhere(inst.id, f, from, to)}
      GROUP BY 1 ORDER BY 1`;
    for (const r of rows) {
      const p = points.get(r.day);
      if (!p) continue;
      Object.assign(p, {
        runs: r.runs,
        success: r.success,
        failure: r.failure,
        cancelled: r.cancelled,
        other: r.other,
        successRate: successRate(r),
        p50: r.p50 == null ? null : Number(r.p50),
        p95: r.p95 == null ? null : Number(r.p95),
        queueP95: r.queue_p95 == null ? null : Number(r.queue_p95),
        billableMinEst: r.minutes,
      });
    }
  } else {
    for (const r of await rollupDays(inst.id, f, fromDay, toDay)) {
      const day = r.day.toISOString().slice(0, 10);
      const p = points.get(day);
      if (!p) continue;
      const dur = r.dur_hist ?? [];
      Object.assign(p, {
        runs: r.runs,
        success: r.success,
        failure: r.failure,
        cancelled: r.cancelled,
        other: r.other,
        successRate: successRate(r),
        p50: histogramPercentile(dur, 0.5),
        p95: histogramPercentile(dur, 0.95),
        queueP95: histogramPercentile(r.queue_hist ?? [], 0.95),
        billableMinEst: r.minutes,
      });
    }
  }
  return [...points.values()];
}

// ---------- freshness ----------

export type Freshness = {
  lastWebhookAt: string | null;
  lastReconciledAt: string | null;
  failedDeliveries: number;
  deadDeliveries: number;
  hasRuns: boolean;
  /** No webhook for 6 h while runs exist, no reconcile for 24 h, or failed deliveries. */
  stale: boolean;
};

export async function getFreshness(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<Freshness> {
  const inst = await visibleInstallation(scope, installationId);
  const [failed, dead, run] = await Promise.all([
    db.webhookDelivery.count({ where: { installationId, status: "FAILED" } }),
    db.webhookDelivery.count({ where: { installationId, status: "DEAD" } }),
    db.workflowRun.findFirst({
      where: { installationId },
      select: { id: true },
    }),
  ]);
  const t = now.getTime();
  const noWebhook =
    !!run &&
    (!inst.lastWebhookAt || t - inst.lastWebhookAt.getTime() > 6 * 3_600_000);
  const noReconcile =
    !inst.lastReconciledAt || t - inst.lastReconciledAt.getTime() > DAY_MS;
  return {
    lastWebhookAt: iso(inst.lastWebhookAt),
    lastReconciledAt: iso(inst.lastReconciledAt),
    failedDeliveries: failed,
    deadDeliveries: dead,
    hasRuns: !!run,
    stale: noWebhook || noReconcile || failed + dead > 0,
  };
}

// ---------- installation overview ----------

export type Overview = {
  range: InsightRange;
  summary: RunSummary;
  /** Success rate over the last 7 days minus the 7 days before. */
  successRateDelta: number | null;
  billableMinEst: number;
  perDay: DayPoint[];
};

export async function getInstallationOverview(
  scope: TenantScope,
  installationId: bigint,
  range: InsightRange = "7d",
  now: Date = new Date(),
): Promise<Overview> {
  const inst = await visibleInstallation(scope, installationId);
  const from = rangeStart(range, now);
  const [summary, days, last7, prev7] = await Promise.all([
    summarize(inst, {}, from, now, now),
    perDay(inst, {}, from, now, now),
    summarize(inst, {}, new Date(now.getTime() - 7 * DAY_MS), now, now),
    summarize(
      inst,
      {},
      new Date(now.getTime() - 14 * DAY_MS),
      new Date(now.getTime() - 7 * DAY_MS),
      now,
    ),
  ]);
  return {
    range,
    summary,
    successRateDelta: trendDelta(last7.successRate, prev7.successRate),
    billableMinEst: days.reduce((s, d) => s + d.billableMinEst, 0),
    perDay: days,
  };
}

// ---------- repositories ----------

export type RepoStat = {
  repositoryId: string;
  fullName: string;
  name: string;
  private: boolean;
  archived: boolean;
  lastRun: {
    id: string;
    status: string;
    conclusion: Conclusion | null;
    createdAt: string;
    workflowName: string;
  } | null;
  runs7d: number;
  successRate7d: number | null;
  p50Duration7d: number | null;
  billableMinEst30d: number;
  /** Last 14 days, oldest first. */
  sparkline: Array<{ day: string; runs: number; failures: number }>;
};

export async function listRepoStats(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<RepoStat[]> {
  const inst = await visibleInstallation(scope, installationId);
  const tz = inst.timezone;
  const from7 = new Date(now.getTime() - 7 * DAY_MS);
  const from14 = new Date(now.getTime() - 14 * DAY_MS);
  const fromDay30 = localDay(new Date(now.getTime() - 30 * DAY_MS), tz);

  const [repos, stats, last, spark, minutes] = await Promise.all([
    db.repository.findMany({
      where: { installationId, removedAt: null },
      orderBy: { fullName: "asc" },
      select: {
        id: true,
        fullName: true,
        name: true,
        private: true,
        archived: true,
      },
    }),
    db.$queryRaw<Array<CountRow & { repositoryId: bigint }>>`
      SELECT r."repositoryId", ${countColumns} FROM "WorkflowRun" r
      WHERE ${runWhere(installationId, {}, from7, now)}
      GROUP BY r."repositoryId"`,
    db.$queryRaw<
      Array<{
        repositoryId: bigint;
        id: bigint;
        status: string;
        conclusion: Conclusion | null;
        createdAt: Date;
        workflowName: string;
      }>
    >`
      SELECT DISTINCT ON (r."repositoryId") r."repositoryId", r."id", r."status"::text AS status,
        r."conclusion"::text AS conclusion, r."createdAt", r."workflowName"
      FROM "WorkflowRun" r
      WHERE r."installationId" = ${installationId} AND NOT r."isPlaceholder"
      ORDER BY r."repositoryId", r."createdAt" DESC`,
    db.$queryRaw<
      Array<{
        repositoryId: bigint;
        day: string;
        runs: number;
        failures: number;
      }>
    >`
      SELECT r."repositoryId",
        to_char((r."createdAt" AT TIME ZONE ${tz}::text)::date, 'YYYY-MM-DD') AS day,
        count(*)::int AS runs,
        count(*) FILTER (WHERE r."conclusion" IN ${FAILURES})::int AS failures
      FROM "WorkflowRun" r
      WHERE ${runWhere(installationId, {}, from14, now)}
      GROUP BY 1, 2`,
    db.$queryRaw<Array<{ repositoryId: bigint; minutes: number }>>`
      SELECT s."repositoryId", sum(s."billableMinEst")::int AS minutes
      FROM "DailyWorkflowStat" s
      WHERE s."installationId" = ${installationId} AND s."day" >= ${fromDay30}::date
      GROUP BY 1`,
  ]);

  const days = daysBetween(localDay(from14, tz), localDay(now, tz)).slice(-14);
  const byRepo = <T extends { repositoryId: bigint }>(rows: T[]) => {
    const m = new Map<bigint, T[]>();
    for (const r of rows)
      m.set(r.repositoryId, [...(m.get(r.repositoryId) ?? []), r]);
    return m;
  };
  const statMap = byRepo(stats);
  const lastMap = byRepo(last);
  const sparkMap = byRepo(spark);
  const minuteMap = byRepo(minutes);

  return repos.map((repo) => {
    const s = statMap.get(repo.id)?.[0];
    const l = lastMap.get(repo.id)?.[0];
    const sp = new Map((sparkMap.get(repo.id) ?? []).map((p) => [p.day, p]));
    return {
      repositoryId: String(repo.id),
      fullName: repo.fullName,
      name: repo.name,
      private: repo.private,
      archived: repo.archived,
      lastRun: l
        ? {
            id: String(l.id),
            status: l.status,
            conclusion: l.conclusion,
            createdAt: l.createdAt.toISOString(),
            workflowName: l.workflowName,
          }
        : null,
      runs7d: s?.runs ?? 0,
      successRate7d: s ? successRate(s) : null,
      p50Duration7d: s?.p50 == null ? null : Number(s.p50),
      billableMinEst30d: minuteMap.get(repo.id)?.[0]?.minutes ?? 0,
      sparkline: days.map((day) => ({
        day,
        runs: sp.get(day)?.runs ?? 0,
        failures: sp.get(day)?.failures ?? 0,
      })),
    };
  });
}

// ---------- workflows ----------

export type WorkflowStat = {
  workflowId: string;
  workflowName: string;
  repositoryId: string;
  repoFullName: string;
  summary: RunSummary;
  billableMinEst: number;
  regression: Regression | null;
  successDrop: { recent: number; baseline: number; drop: number } | null;
  sparkline: Array<{ day: string; runs: number; failures: number }>;
};

type WindowStats = PercentileWindow & { success: number; failure: number };

/** Per-workflow duration percentiles and outcome counts over [from, to). */
async function windowByWorkflow(
  inst: InstallationInfo,
  repositoryId: bigint | undefined,
  from: Date,
  to: Date,
  now: Date,
): Promise<Map<bigint, WindowStats>> {
  const out = new Map<bigint, WindowStats>();
  const f: RunFilter = repositoryId !== undefined ? { repositoryId } : {};
  if (insideRetention(inst, from, now)) {
    const rows = await db.$queryRaw<Array<CountRow & { workflowId: bigint }>>`
      SELECT r."workflowId", ${countColumns} FROM "WorkflowRun" r
      WHERE ${runWhere(inst.id, f, from, to)} AND r."workflowId" IS NOT NULL
      GROUP BY r."workflowId"`;
    for (const r of rows)
      out.set(r.workflowId, {
        n: r.n,
        p50: r.p50 == null ? null : Number(r.p50),
        p95: r.p95 == null ? null : Number(r.p95),
        success: r.success,
        failure: r.failure,
      });
    return out;
  }
  const rows = await db.$queryRaw<
    Array<{
      workflowId: bigint;
      success: number;
      failure: number;
      dur_hist: number[];
    }>
  >`
    SELECT s."workflowId", sum(s."success")::int AS success, sum(s."failure")::int AS failure,
      hist_sum(s."durHist") AS dur_hist
    FROM "DailyWorkflowStat" s
    WHERE ${statWhere(inst.id, f, localDay(from, inst.timezone), localDay(to, inst.timezone))}
    GROUP BY s."workflowId"`;
  for (const r of rows)
    out.set(r.workflowId, {
      n: histogramCount(r.dur_hist),
      p50: histogramPercentile(r.dur_hist, 0.5),
      p95: histogramPercentile(r.dur_hist, 0.95),
      success: r.success,
      failure: r.failure,
    });
  return out;
}

/** Regression and success-drop flags: last 7 days vs the prior 28 days. */
async function alertsByWorkflow(
  inst: InstallationInfo,
  repositoryId: bigint | undefined,
  now: Date,
) {
  const recentFrom = new Date(now.getTime() - 7 * DAY_MS);
  const baseFrom = new Date(now.getTime() - 35 * DAY_MS);
  const [recent, baseline] = await Promise.all([
    windowByWorkflow(inst, repositoryId, recentFrom, now, now),
    windowByWorkflow(inst, repositoryId, baseFrom, recentFrom, now),
  ]);
  const out = new Map<
    bigint,
    {
      regression: Regression | null;
      successDrop: ReturnType<typeof detectSuccessDrop>;
    }
  >();
  for (const [id, r] of recent) {
    const b = baseline.get(id);
    if (!b) continue;
    out.set(id, {
      regression: detectRegression(r, b),
      successDrop: detectSuccessDrop(r, b),
    });
  }
  return out;
}

export async function listWorkflowStats(
  scope: TenantScope,
  installationId: bigint,
  opts: { repositoryId?: bigint; range?: InsightRange } = {},
  now: Date = new Date(),
): Promise<WorkflowStat[]> {
  const inst = await visibleInstallation(scope, installationId);
  if (opts.repositoryId !== undefined)
    await visibleRepository(installationId, opts.repositoryId);
  const range = opts.range ?? "30d";
  const from = rangeStart(range, now);
  const f: RunFilter =
    opts.repositoryId !== undefined ? { repositoryId: opts.repositoryId } : {};
  const exact =
    insideRetention(inst, from, now) &&
    (await rawCount(inst.id, f, from, now)) < EXACT_LIMIT;

  type Row = {
    workflowId: bigint;
    repositoryId: bigint;
    summary: RunSummary;
    minutes: number;
    name: string;
  };
  const rows: Row[] = [];
  if (exact) {
    const raw = await db.$queryRaw<
      Array<
        CountRow & {
          workflowId: bigint;
          repositoryId: bigint;
          name: string;
          queue_p95: number | null;
          minutes: number;
        }
      >
    >`
      SELECT r."workflowId", r."repositoryId", max(r."workflowName") AS name, ${countColumns},
        percentile_cont(0.95) WITHIN GROUP (ORDER BY q."queueS") AS queue_p95,
        COALESCE(sum(m.minutes), 0)::int AS minutes
      FROM "WorkflowRun" r
      LEFT JOIN LATERAL (
        SELECT j."queueS" FROM "WorkflowJob" j
        WHERE j."runId" = r."id" AND j."runAttempt" = r."runAttempt" AND j."queueS" IS NOT NULL
        ORDER BY j."startedAt" ASC, j."id" ASC LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(j."billableMinEst"), 0) AS minutes
        FROM "WorkflowJob" j WHERE j."runId" = r."id"
      ) m ON true
      WHERE ${runWhere(inst.id, f, from, now)} AND r."workflowId" IS NOT NULL
      GROUP BY r."workflowId", r."repositoryId"`;
    for (const r of raw)
      rows.push({
        workflowId: r.workflowId,
        repositoryId: r.repositoryId,
        name: r.name,
        minutes: r.minutes,
        summary: summaryOf(
          { ...r, firstTrySuccess: r.first_try, flakyRecovered: r.flaky },
          r.queue_p95 == null ? null : Number(r.queue_p95),
          false,
        ),
      });
  } else {
    const agg = await db.$queryRaw<
      Array<
        StatRow & { workflowId: bigint; repositoryId: bigint; name: string }
      >
    >`
      SELECT s."workflowId", s."repositoryId", max(s."workflowName") AS name, min(s."day") AS day,
        sum(s."runs")::int AS runs, sum(s."success")::int AS success,
        sum(s."failure")::int AS failure, sum(s."cancelled")::int AS cancelled,
        sum(s."other")::int AS other, sum(s."firstTrySuccess")::int AS first_try,
        sum(s."flakyRecovered")::int AS flaky,
        hist_sum(s."durHist") AS dur_hist, hist_sum(s."queueHist") AS queue_hist,
        sum(s."billableMinEst")::int AS minutes
      FROM "DailyWorkflowStat" s
      WHERE ${statWhere(inst.id, f, localDay(from, inst.timezone), localDay(now, inst.timezone))}
      GROUP BY s."workflowId", s."repositoryId"`;
    for (const r of agg)
      rows.push({
        workflowId: r.workflowId,
        repositoryId: r.repositoryId,
        name: r.name,
        minutes: r.minutes,
        summary: rollupSummary([r]),
      });
  }

  const tz = inst.timezone;
  const from14 = new Date(now.getTime() - 14 * DAY_MS);
  const [alerts, repos, spark] = await Promise.all([
    alertsByWorkflow(inst, opts.repositoryId, now),
    db.repository.findMany({
      where: { installationId },
      select: { id: true, fullName: true },
    }),
    db.$queryRaw<
      Array<{ workflowId: bigint; day: string; runs: number; failures: number }>
    >`
      SELECT r."workflowId",
        to_char((r."createdAt" AT TIME ZONE ${tz}::text)::date, 'YYYY-MM-DD') AS day,
        count(*)::int AS runs,
        count(*) FILTER (WHERE r."conclusion" IN ${FAILURES})::int AS failures
      FROM "WorkflowRun" r
      WHERE ${runWhere(inst.id, f, from14, now)} AND r."workflowId" IS NOT NULL
      GROUP BY 1, 2`,
  ]);
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  const days = daysBetween(localDay(from14, tz), localDay(now, tz)).slice(-14);
  const sparkBy = new Map<
    bigint,
    Map<string, { runs: number; failures: number }>
  >();
  for (const p of spark) {
    const m = sparkBy.get(p.workflowId) ?? new Map();
    m.set(p.day, p);
    sparkBy.set(p.workflowId, m);
  }

  return rows
    .map((r) => ({
      workflowId: String(r.workflowId),
      workflowName: r.name,
      repositoryId: String(r.repositoryId),
      repoFullName: repoName.get(r.repositoryId) ?? "",
      summary: r.summary,
      billableMinEst: r.minutes,
      regression: alerts.get(r.workflowId)?.regression ?? null,
      successDrop: alerts.get(r.workflowId)?.successDrop ?? null,
      sparkline: days.map((day) => ({
        day,
        runs: sparkBy.get(r.workflowId)?.get(day)?.runs ?? 0,
        failures: sparkBy.get(r.workflowId)?.get(day)?.failures ?? 0,
      })),
    }))
    .sort(
      (a, b) =>
        a.repoFullName.localeCompare(b.repoFullName) ||
        a.workflowName.localeCompare(b.workflowName),
    );
}

export type JobBreakdown = {
  baseName: string;
  labelKey: string;
  runnerKind: string;
  jobs: number;
  failureRate: number | null;
  p50: number | null;
  p95: number | null;
  queueP95: number | null;
  billableMinEst: number;
  flakyRuns: number;
};

export type WorkflowDetail = {
  workflowId: string;
  workflowName: string;
  repositoryId: string;
  repoFullName: string;
  range: InsightRange;
  summary: RunSummary;
  perDay: DayPoint[];
  jobs: JobBreakdown[];
  regression: Regression | null;
  successDrop: { recent: number; baseline: number; drop: number } | null;
  approx: boolean;
};

export async function getWorkflowDetail(
  scope: TenantScope,
  installationId: bigint,
  workflowId: bigint,
  range: InsightRange = "30d",
  now: Date = new Date(),
): Promise<WorkflowDetail> {
  const inst = await visibleInstallation(scope, installationId);
  const head = await db.workflowRun.findFirst({
    where: { installationId, workflowId },
    orderBy: { createdAt: "desc" },
    select: { workflowName: true, repositoryId: true },
  });
  if (!head) throw new NotFoundError();
  const repo = await visibleRepository(installationId, head.repositoryId);
  const from = rangeStart(range, now);
  const f: RunFilter = { workflowId };
  const exact = insideRetention(inst, from, now);

  const [summary, days, alerts] = await Promise.all([
    summarize(inst, f, from, now, now),
    perDay(inst, f, from, now, now),
    alertsByWorkflow(inst, head.repositoryId, now),
  ]);

  let jobs: JobBreakdown[];
  if (exact) {
    const rows = await db.$queryRaw<
      Array<{
        baseName: string;
        labelKey: string;
        runnerKind: string;
        jobs: number;
        success: number;
        failure: number;
        p50: number | null;
        p95: number | null;
        queue_p95: number | null;
        minutes: number;
      }>
    >`
      SELECT j."baseName", j."labelKey", j."runnerKind"::text AS "runnerKind",
        count(*)::int AS jobs,
        count(*) FILTER (WHERE j."conclusion" = 'SUCCESS')::int AS success,
        count(*) FILTER (WHERE j."conclusion" IN ${FAILURES})::int AS failure,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY j."durationS")
          FILTER (WHERE j."conclusion" IS DISTINCT FROM 'SKIPPED') AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY j."durationS")
          FILTER (WHERE j."conclusion" IS DISTINCT FROM 'SKIPPED') AS p95,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY j."queueS") AS queue_p95,
        COALESCE(sum(j."billableMinEst"), 0)::int AS minutes
      FROM "WorkflowJob" j
      JOIN "WorkflowRun" r ON r."id" = j."runId"
      WHERE j."installationId" = ${installationId} AND r."installationId" = ${installationId}
        AND r."workflowId" = ${workflowId} AND j."statusRank" = 4
        AND j."createdAt" >= ${from} AND j."createdAt" < ${now}
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`;
    jobs = rows.map((r) => ({
      baseName: r.baseName,
      labelKey: r.labelKey,
      runnerKind: r.runnerKind,
      jobs: r.jobs,
      failureRate: successRate(r) == null ? null : 1 - successRate(r)!,
      p50: r.p50 == null ? null : Number(r.p50),
      p95: r.p95 == null ? null : Number(r.p95),
      queueP95: r.queue_p95 == null ? null : Number(r.queue_p95),
      billableMinEst: r.minutes,
      flakyRuns: 0,
    }));
  } else {
    const rows = await db.$queryRaw<
      Array<{
        baseName: string;
        labelKey: string;
        runnerKind: string;
        jobs: number;
        success: number;
        failure: number;
        dur_hist: number[];
        queue_hist: number[];
        minutes: number;
      }>
    >`
      SELECT s."baseName", s."labelKey", s."runnerKind"::text AS "runnerKind",
        sum(s."jobs")::int AS jobs, sum(s."success")::int AS success, sum(s."failure")::int AS failure,
        hist_sum(s."durHist") AS dur_hist, hist_sum(s."queueHist") AS queue_hist,
        sum(s."billableMinEst")::int AS minutes
      FROM "DailyJobStat" s
      WHERE s."installationId" = ${installationId} AND s."workflowId" = ${workflowId}
        AND s."day" >= ${localDay(from, inst.timezone)}::date
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    jobs = rows.map((r) => ({
      baseName: r.baseName,
      labelKey: r.labelKey,
      runnerKind: r.runnerKind,
      jobs: r.jobs,
      failureRate: successRate(r) == null ? null : 1 - successRate(r)!,
      p50: histogramPercentile(r.dur_hist, 0.5),
      p95: histogramPercentile(r.dur_hist, 0.95),
      queueP95: histogramPercentile(r.queue_hist, 0.95),
      billableMinEst: r.minutes,
      flakyRuns: 0,
    }));
  }

  // Flaky jobs need attempts, which only raw rows have.
  if (insideRetention(inst, from, now)) {
    const flaky = detectFlakyJobs(
      await flakyCandidates(installationId, from, now, workflowId),
    );
    const byName = new Map(flaky.map((f) => [f.baseName, f.runs]));
    for (const j of jobs) j.flakyRuns = byName.get(j.baseName) ?? 0;
  }

  return {
    workflowId: String(workflowId),
    workflowName: head.workflowName,
    repositoryId: String(repo.id),
    repoFullName: repo.fullName,
    range,
    summary,
    perDay: days,
    jobs,
    regression: alerts.get(workflowId)?.regression ?? null,
    successDrop: alerts.get(workflowId)?.successDrop ?? null,
    approx: summary.approx,
  };
}

async function flakyCandidates(
  installationId: bigint,
  from: Date,
  to: Date,
  workflowId?: bigint,
) {
  return db.$queryRaw<
    Array<{
      runId: bigint;
      runAttempt: number;
      baseName: string;
      conclusion: Conclusion | null;
      workflowId: bigint | null;
    }>
  >`
    SELECT j."runId", j."runAttempt", j."baseName", j."conclusion"::text AS conclusion,
      r."workflowId"
    FROM "WorkflowJob" j JOIN "WorkflowRun" r ON r."id" = j."runId"
    WHERE r."installationId" = ${installationId} AND j."installationId" = ${installationId}
      AND r."runAttempt" > 1 AND j."statusRank" = 4
      AND r."createdAt" >= ${from} AND r."createdAt" < ${to}
      ${workflowId !== undefined ? Prisma.sql`AND r."workflowId" = ${workflowId}` : Prisma.empty}
    LIMIT 20000`;
}

export type FlakyJobStat = {
  workflowId: string;
  workflowName: string;
  repoFullName: string;
  baseName: string;
  runs: number;
};

/** Flaky jobs (failed, then succeeded in a later attempt of the same run). */
export async function listFlakyJobs(
  scope: TenantScope,
  installationId: bigint,
  range: InsightRange = "30d",
  now: Date = new Date(),
): Promise<FlakyJobStat[]> {
  const inst = await visibleInstallation(scope, installationId);
  const from = rangeStart(range, now);
  if (!insideRetention(inst, from, now)) return [];
  const rows = await flakyCandidates(installationId, from, now);
  const key = (wf: bigint | null, name: string) => `${wf ?? 0}\u0000${name}`;
  const flaky = detectFlakyJobs(
    rows.map((r) => ({ ...r, baseName: key(r.workflowId, r.baseName) })),
  );
  if (flaky.length === 0) return [];
  const runs = await db.workflowRun.findMany({
    where: {
      installationId,
      workflowId: {
        in: [
          ...new Set(flaky.map((f) => BigInt(f.baseName.split("\u0000")[0]!))),
        ],
      },
    },
    distinct: ["workflowId"],
    orderBy: { createdAt: "desc" },
    select: { workflowId: true, workflowName: true, repositoryId: true },
  });
  const repos = await db.repository.findMany({
    where: { installationId },
    select: { id: true, fullName: true },
  });
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  const wf = new Map(runs.map((r) => [String(r.workflowId), r]));
  return flaky.slice(0, 50).map((f) => {
    const [id, baseName] = f.baseName.split("\u0000") as [string, string];
    const w = wf.get(id);
    return {
      workflowId: id,
      workflowName: w?.workflowName ?? "",
      repoFullName: w ? (repoName.get(w.repositoryId) ?? "") : "",
      baseName,
      runs: f.runs,
    };
  });
}

/** Workflows with a regression badge or a success drop. */
export async function listAlerts(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<{ regressions: WorkflowStat[]; successDrops: WorkflowStat[] }> {
  const all = await listWorkflowStats(
    scope,
    installationId,
    { range: "7d" },
    now,
  );
  return {
    regressions: all
      .filter((w) => w.regression)
      .sort((a, b) => b.regression!.ratio - a.regression!.ratio),
    successDrops: all
      .filter((w) => w.successDrop)
      .sort((a, b) => b.successDrop!.drop - a.successDrop!.drop),
  };
}

// ---------- runs ----------

export type RunListItem = {
  id: string;
  repositoryId: string;
  repoFullName: string;
  workflowId: string | null;
  workflowName: string;
  runNumber: number | null;
  runAttempt: number;
  event: string | null;
  headBranch: string | null;
  headSha: string;
  actorLogin: string | null;
  status: string;
  conclusion: Conclusion | null;
  createdAt: string;
  durationS: number | null;
  htmlUrl: string | null;
  isPlaceholder: boolean;
};

export type RunListFilter = {
  repositoryId?: bigint;
  workflowId?: bigint;
  branch?: string;
  event?: string;
  conclusion?: Conclusion;
  actor?: string;
  /** Keyset cursor from the previous page. */
  before?: { createdAt: string; id: string };
  limit?: number;
};

export async function listRuns(
  scope: TenantScope,
  installationId: bigint,
  filter: RunListFilter = {},
): Promise<{
  runs: RunListItem[];
  next: { createdAt: string; id: string } | null;
}> {
  await visibleInstallation(scope, installationId);
  if (filter.repositoryId !== undefined)
    await visibleRepository(installationId, filter.repositoryId);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = await db.workflowRun.findMany({
    where: {
      installationId,
      ...(filter.repositoryId !== undefined
        ? { repositoryId: filter.repositoryId }
        : {}),
      ...(filter.workflowId !== undefined
        ? { workflowId: filter.workflowId }
        : {}),
      ...(filter.branch ? { headBranch: filter.branch } : {}),
      ...(filter.event ? { event: filter.event } : {}),
      ...(filter.conclusion ? { conclusion: filter.conclusion } : {}),
      ...(filter.actor ? { actorLogin: filter.actor } : {}),
      ...(filter.before
        ? {
            OR: [
              { createdAt: { lt: new Date(filter.before.createdAt) } },
              {
                createdAt: new Date(filter.before.createdAt),
                id: { lt: BigInt(filter.before.id) },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const repos = await db.repository.findMany({
    where: {
      installationId,
      id: { in: [...new Set(rows.map((r) => r.repositoryId))] },
    },
    select: { id: true, fullName: true },
  });
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map((r) => ({
      id: String(r.id),
      repositoryId: String(r.repositoryId),
      repoFullName: repoName.get(r.repositoryId) ?? "",
      workflowId: r.workflowId == null ? null : String(r.workflowId),
      workflowName: r.workflowName,
      runNumber: r.runNumber,
      runAttempt: r.runAttempt,
      event: r.event,
      headBranch: r.headBranch,
      headSha: r.headSha,
      actorLogin: r.actorLogin,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.createdAt.toISOString(),
      durationS: r.durationS,
      htmlUrl: r.htmlUrl,
      isPlaceholder: r.isPlaceholder,
    })),
    next:
      rows.length > limit && last
        ? { createdAt: last.createdAt.toISOString(), id: String(last.id) }
        : null,
  };
}

export type TimelineJob = {
  id: string;
  name: string;
  baseName: string;
  labels: string[];
  status: string;
  conclusion: Conclusion | null;
  runnerName: string | null;
  runnerKind: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  waitingS: number;
  queueS: number | null;
  durationS: number | null;
  billableMinEst: number | null;
  /** Seconds from the earliest job creation of the attempt. */
  offsets: {
    created: number;
    waitEnd: number | null;
    started: number | null;
    completed: number | null;
  };
};

export type RunDetail = {
  run: RunListItem & {
    firstAttemptConclusion: Conclusion | null;
    runStartedAt: string | null;
    completedAt: string | null;
  };
  attempt: number;
  attempts: number[];
  jobs: TimelineJob[];
  timings: {
    wallS: number | null;
    computeS: number;
    parallelism: number | null;
    firstQueueS: number | null;
  };
};

export async function getRunDetail(
  scope: TenantScope,
  installationId: bigint,
  runId: bigint,
  attempt?: number,
): Promise<RunDetail> {
  await visibleInstallation(scope, installationId);
  const run = await db.workflowRun.findFirst({
    where: { id: runId, installationId },
  });
  if (!run) throw new NotFoundError();
  const repo = await db.repository.findFirst({
    where: { id: run.repositoryId, installationId },
    select: { fullName: true },
  });
  const jobsAll = await db.workflowJob.findMany({
    where: { runId, installationId },
    orderBy: [{ runAttempt: "asc" }, { startedAt: "asc" }, { id: "asc" }],
  });
  const attempts = [
    ...new Set([run.runAttempt, ...jobsAll.map((j) => j.runAttempt)]),
  ].sort((a, b) => a - b);
  const selected =
    attempt !== undefined && attempts.includes(attempt)
      ? attempt
      : run.runAttempt;
  const jobs = jobsAll.filter((j) => j.runAttempt === selected);
  const origin = Math.min(
    ...jobs.map((j) => j.createdAt.getTime()),
    run.runStartedAt?.getTime() ?? Infinity,
  );
  const off = (d: Date | null) =>
    d && Number.isFinite(origin)
      ? Math.round((d.getTime() - origin) / 1000)
      : null;
  const timings = runTimings(
    selected === run.runAttempt
      ? { runStartedAt: run.runStartedAt, completedAt: run.completedAt }
      : { runStartedAt: null, completedAt: null },
    jobs,
  );
  return {
    run: {
      id: String(run.id),
      repositoryId: String(run.repositoryId),
      repoFullName: repo?.fullName ?? "",
      workflowId: run.workflowId == null ? null : String(run.workflowId),
      workflowName: run.workflowName,
      runNumber: run.runNumber,
      runAttempt: run.runAttempt,
      event: run.event,
      headBranch: run.headBranch,
      headSha: run.headSha,
      actorLogin: run.actorLogin,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.createdAt.toISOString(),
      durationS: run.durationS,
      htmlUrl: run.htmlUrl,
      isPlaceholder: run.isPlaceholder,
      firstAttemptConclusion: run.firstAttemptConclusion,
      runStartedAt: iso(run.runStartedAt),
      completedAt: iso(run.completedAt),
    },
    attempt: selected,
    attempts,
    jobs: jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      baseName: j.baseName,
      labels: j.labels,
      status: j.status,
      conclusion: j.conclusion,
      runnerName: j.runnerName,
      runnerKind: j.runnerKind,
      createdAt: j.createdAt.toISOString(),
      startedAt: iso(j.startedAt),
      completedAt: iso(j.completedAt),
      waitingS: j.waitingS,
      queueS: j.queueS,
      durationS: j.durationS,
      billableMinEst: j.billableMinEst,
      offsets: {
        created: off(j.createdAt) ?? 0,
        waitEnd:
          j.waitingS > 0 && j.waitingStartedAt
            ? off(new Date(j.waitingStartedAt.getTime() + j.waitingS * 1000))
            : null,
        started: off(j.startedAt),
        completed: off(j.completedAt),
      },
    })),
    timings,
  };
}

// ---------- sync health (admin) ----------

export type SyncHealth = {
  lastWebhookAt: string | null;
  lastReconciledAt: string | null;
  repos: Array<{
    repositoryId: string;
    fullName: string;
    runsCursor: string | null;
    backfillUntil: string | null;
    backfillDone: boolean;
    /** 0..1 of the backfill span covered. */
    backfillProgress: number;
    needsResync: boolean;
    lastError: string | null;
  }>;
  deliveries24h: Record<string, number>;
  ingestionLag: { p50: number | null; p95: number | null };
  rateLimits: Array<{
    resource: string;
    limit: number;
    remaining: number;
    resetAt: string;
  }>;
  dirtyPartitions: number;
};

/** Admin only: other roles get NotFoundError (admin pages answer 404). */
export async function getSyncHealth(
  scope: TenantScope,
  installationId: bigint,
  backfillDays: number,
  now: Date = new Date(),
): Promise<SyncHealth> {
  if (!hasRole(scope.role, "ADMIN")) throw new NotFoundError();
  const inst = await visibleInstallation(scope, installationId);
  const since = new Date(now.getTime() - DAY_MS);
  const [repos, states, deliveries, lag, limits, dirty] = await Promise.all([
    db.repository.findMany({
      where: { installationId, removedAt: null },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true },
    }),
    db.syncState.findMany({ where: { installationId } }),
    db.webhookDelivery.groupBy({
      by: ["status"],
      where: { installationId, receivedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.$queryRaw<Array<{ p50: number | null; p95: number | null }>>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("processedAt" - "receivedAt"))) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ("processedAt" - "receivedAt"))) AS p95
      FROM "WebhookDelivery"
      WHERE "installationId" = ${installationId} AND "status" = 'PROCESSED'
        AND "receivedAt" >= ${since} AND "processedAt" IS NOT NULL`,
    db.installationRateLimit.findMany({ where: { installationId } }),
    db.rollupDirty.count({ where: { installationId } }),
  ]);
  const stateBy = new Map(states.map((s) => [s.repositoryId, s]));
  const span = Math.max(1, backfillDays) * DAY_MS;
  return {
    lastWebhookAt: iso(inst.lastWebhookAt),
    lastReconciledAt: iso(inst.lastReconciledAt),
    repos: repos.map((repo) => {
      const s = stateBy.get(repo.id);
      const covered =
        s?.backfillUntil && s.runsCursor
          ? (s.runsCursor.getTime() - s.backfillUntil.getTime()) / span
          : 0;
      return {
        repositoryId: String(repo.id),
        fullName: repo.fullName,
        runsCursor: iso(s?.runsCursor),
        backfillUntil: iso(s?.backfillUntil),
        backfillDone: s?.backfillDone ?? false,
        backfillProgress: s?.backfillDone
          ? 1
          : Math.min(1, Math.max(0, covered)),
        needsResync: s?.needsResync ?? false,
        lastError: s?.lastError ?? null,
      };
    }),
    deliveries24h: Object.fromEntries(
      deliveries.map((d) => [d.status, d._count._all]),
    ),
    ingestionLag: {
      p50: lag[0]?.p50 == null ? null : Number(lag[0].p50),
      p95: lag[0]?.p95 == null ? null : Number(lag[0].p95),
    },
    rateLimits: limits.map((l) => ({
      resource: l.resource,
      limit: l.limit,
      remaining: l.remaining,
      resetAt: l.resetAt.toISOString(),
    })),
    dirtyPartitions: dirty,
  };
}

/** Repository of a visible installation by name, for `/repos/[repo]` routes. */
export async function findRepositoryByName(
  scope: TenantScope,
  installationId: bigint,
  name: string,
): Promise<{ id: string; fullName: string; defaultBranch: string } | null> {
  if (!inScope(scope, installationId)) return null;
  const repo = await db.repository.findFirst({
    where: {
      installationId,
      removedAt: null,
      name: { equals: name, mode: "insensitive" },
      installation: { deletedAt: null, suspendedAt: null },
    },
    select: { id: true, fullName: true, defaultBranch: true },
  });
  return repo
    ? {
        id: String(repo.id),
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
      }
    : null;
}
