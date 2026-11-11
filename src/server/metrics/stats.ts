/**
 * Metric definitions (design §6.1-6.3, §6.7). Pure functions over plain rows,
 * shared by the data layer (raw rows and rollups) and the tests.
 */

export type Conclusion =
  | "SUCCESS"
  | "FAILURE"
  | "CANCELLED"
  | "SKIPPED"
  | "TIMED_OUT"
  | "ACTION_REQUIRED"
  | "NEUTRAL"
  | "STALE"
  | "STARTUP_FAILURE";

/** Conclusions that count as a failure in the success-rate denominator. */
export const FAILURE_CONCLUSIONS: ReadonlySet<Conclusion> = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
]);

/** Conclusions outside the denominator, shown as separate counts. */
export const OTHER_CONCLUSIONS: ReadonlySet<Conclusion> = new Set([
  "SKIPPED",
  "NEUTRAL",
  "ACTION_REQUIRED",
  "STALE",
]);

export function isFailure(c: Conclusion | null | undefined): boolean {
  return c != null && FAILURE_CONCLUSIONS.has(c);
}

export type ConclusionCounts = {
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  other: number;
};

export function countConclusions(
  conclusions: Iterable<Conclusion | null>,
): ConclusionCounts {
  const out = { runs: 0, success: 0, failure: 0, cancelled: 0, other: 0 };
  for (const c of conclusions) {
    out.runs++;
    if (c === "SUCCESS") out.success++;
    else if (isFailure(c)) out.failure++;
    else if (c === "CANCELLED") out.cancelled++;
    else if (c != null) out.other++;
  }
  return out;
}

/** success / (success + failure + timed_out + startup_failure); null without data. */
export function successRate(c: {
  success: number;
  failure: number;
}): number | null {
  const denominator = c.success + c.failure;
  return denominator === 0 ? null : c.success / denominator;
}

export function cancellationRate(c: {
  runs: number;
  cancelled: number;
}): number | null {
  return c.runs === 0 ? null : c.cancelled / c.runs;
}

/** firstTrySuccess / runs counted in the success-rate denominator. */
export function firstTrySuccessRate(c: {
  success: number;
  failure: number;
  firstTrySuccess: number;
}): number | null {
  const denominator = c.success + c.failure;
  return denominator === 0 ? null : c.firstTrySuccess / denominator;
}

/** flakyRecovered / successful runs. */
export function flakyRate(c: {
  success: number;
  flakyRecovered: number;
}): number | null {
  return c.success === 0 ? null : c.flakyRecovered / c.success;
}

/** Same as `percentile_cont(p) WITHIN GROUP (ORDER BY x)`. */
export function percentileExact(
  values: ReadonlyArray<number>,
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (rank - lo);
}

// ---------- job and run timings (§6.1, §6.2) ----------

const seconds = (from: Date, to: Date) =>
  Math.round((to.getTime() - from.getTime()) / 1000);

export type JobTimes = {
  conclusion: Conclusion | null;
  runnerName: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  waitingS: number;
};

/** conclusion SKIPPED, or no runner and startedAt = completedAt. */
export function isSkippedJob(job: JobTimes): boolean {
  if (job.conclusion === "SKIPPED") return true;
  return (
    job.runnerName == null &&
    job.startedAt != null &&
    job.completedAt != null &&
    job.startedAt.getTime() === job.completedAt.getTime()
  );
}

/** Cancelled while still queued (never got a runner). */
export function isAbandonedInQueue(job: JobTimes): boolean {
  return job.conclusion === "CANCELLED" && job.runnerName == null;
}

/** max(0, startedAt - createdAt - waitingS), only for jobs that got a runner. */
export function queueSeconds(job: JobTimes): number | null {
  if (!job.startedAt || job.runnerName == null) return null;
  if (isSkippedJob(job) || isAbandonedInQueue(job)) return null;
  return Math.max(0, seconds(job.createdAt, job.startedAt) - job.waitingS);
}

/** completedAt - startedAt, when both are set. */
export function executionSeconds(job: {
  startedAt: Date | null;
  completedAt: Date | null;
}): number | null {
  if (!job.startedAt || !job.completedAt) return null;
  return Math.max(0, seconds(job.startedAt, job.completedAt));
}

export type RunAttemptJobs = ReadonlyArray<
  JobTimes & { durationS: number | null; queueS: number | null }
>;

export type RunTimings = {
  wallS: number | null;
  computeS: number;
  parallelism: number | null;
  firstQueueS: number | null;
};

/**
 * Wall clock (runStartedAt to the last job's completion, falling back to the
 * run's completedAt), compute (sum of job durations), parallelism and the
 * queue time of the first job to start.
 */
export function runTimings(
  run: { runStartedAt: Date | null; completedAt: Date | null },
  jobs: RunAttemptJobs,
): RunTimings {
  const ends = jobs
    .map((j) => j.completedAt?.getTime())
    .filter((t): t is number => t != null);
  const end =
    ends.length > 0 ? new Date(Math.max(...ends)) : (run.completedAt ?? null);
  const wallS =
    run.runStartedAt && end
      ? Math.max(0, seconds(run.runStartedAt, end))
      : null;
  const computeS = jobs.reduce((sum, j) => sum + (j.durationS ?? 0), 0);
  const started = jobs
    .filter((j) => j.startedAt && !isSkippedJob(j))
    .sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime());
  return {
    wallS,
    computeS,
    parallelism: wallS && wallS > 0 ? computeS / wallS : null,
    firstQueueS: started[0]?.queueS ?? null,
  };
}

// ---------- flakiness (§6.3) ----------

/** Attempt 1 failed and the latest attempt succeeded. */
export function isFlakyRun(run: {
  runAttempt: number;
  firstAttemptConclusion: Conclusion | null;
  conclusion: Conclusion | null;
}): boolean {
  return (
    run.runAttempt > 1 &&
    isFailure(run.firstAttemptConclusion) &&
    run.conclusion === "SUCCESS"
  );
}

export type FlakyJobInput = {
  runId: bigint | string;
  runAttempt: number;
  baseName: string;
  conclusion: Conclusion | null;
};

export type FlakyJob = { baseName: string; runs: number };

/**
 * Flaky job: the same run and baseName failed in attempt n and succeeded in a
 * later attempt n+k. Returns the number of affected runs per baseName, most
 * affected first.
 */
export function detectFlakyJobs(
  jobs: ReadonlyArray<FlakyJobInput>,
): FlakyJob[] {
  const groups = new Map<string, FlakyJobInput[]>();
  for (const job of jobs) {
    const key = `${job.runId}\u0000${job.baseName}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(job);
  }
  const perName = new Map<string, number>();
  for (const list of groups.values()) {
    let firstFailure = Infinity;
    for (const j of list)
      if (isFailure(j.conclusion))
        firstFailure = Math.min(firstFailure, j.runAttempt);
    const recovered = list.some(
      (j) => j.conclusion === "SUCCESS" && j.runAttempt > firstFailure,
    );
    if (recovered) {
      const name = list[0]!.baseName;
      perName.set(name, (perName.get(name) ?? 0) + 1);
    }
  }
  return [...perName]
    .map(([baseName, runs]) => ({ baseName, runs }))
    .sort((a, b) => b.runs - a.runs || a.baseName.localeCompare(b.baseName));
}

// ---------- trends, regressions, success drops (§6.3) ----------

export const REGRESSION_FACTOR = 1.2;
export const MIN_SAMPLES = 10;
export const SUCCESS_DROP_POINTS = 0.1;

export type PercentileWindow = {
  n: number;
  p50: number | null;
  p95: number | null;
};

export type Regression = {
  metric: "p50" | "p95";
  recent: number;
  baseline: number;
  ratio: number;
};

/**
 * Regression badge: p50 or p95 duration over the last 7 days above 1.2x the
 * same percentile over the prior 28 days, with n >= 10 on both sides.
 * Returns the worse of the two, or null.
 */
export function detectRegression(
  recent: PercentileWindow,
  baseline: PercentileWindow,
): Regression | null {
  if (recent.n < MIN_SAMPLES || baseline.n < MIN_SAMPLES) return null;
  let worst: Regression | null = null;
  for (const metric of ["p50", "p95"] as const) {
    const r = recent[metric];
    const b = baseline[metric];
    if (r == null || b == null || b <= 0) continue;
    const ratio = r / b;
    if (ratio > REGRESSION_FACTOR && (!worst || ratio > worst.ratio))
      worst = { metric, recent: r, baseline: b, ratio };
  }
  return worst;
}

export type RateWindow = { success: number; failure: number };

/**
 * Success-drop flag: the success rate over the last 7 days at least 10
 * percentage points below the prior 28 days, with n >= 10 on both sides.
 */
export function detectSuccessDrop(
  recent: RateWindow,
  baseline: RateWindow,
): { recent: number; baseline: number; drop: number } | null {
  const nr = recent.success + recent.failure;
  const nb = baseline.success + baseline.failure;
  if (nr < MIN_SAMPLES || nb < MIN_SAMPLES) return null;
  const r = successRate(recent)!;
  const b = successRate(baseline)!;
  const drop = b - r;
  return drop >= SUCCESS_DROP_POINTS - 1e-12
    ? { recent: r, baseline: b, drop }
    : null;
}

/** Value over the last 7 days minus the value over the previous 7 days. */
export function trendDelta(
  current: number | null,
  previous: number | null,
): number | null {
  return current == null || previous == null ? null : current - previous;
}
