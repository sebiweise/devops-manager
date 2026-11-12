import { normalizeLabels, type RunnerKind } from "./classify";
import { percentileExact, type Conclusion } from "./stats";

/**
 * Runner utilisation, queue and comparison metrics (design §6.5). Pure
 * functions over plain rows; the data layer and the DailyRunnerStat rollup
 * feed them from the database. Times are epoch milliseconds inside, seconds
 * in the results.
 */

export type Interval = { start: number; end: number };
export type TimeWindow = { from: number; to: number };

/** Below this coverage (onlineS / window) utilisation is "insufficient samples". */
export const MIN_SAMPLE_COVERAGE = 0.5;
/** A queued self-hosted job older than this without a free runner is STUCK. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
/** Comparisons and the speed index need this many jobs per side. */
export const MIN_COMPARE_SAMPLES = 5;
/** Concurrency timeline bucket (5 minutes). */
export const CONCURRENCY_BUCKET_S = 300;

function clip(i: Interval, w: TimeWindow): Interval | null {
  const start = Math.max(i.start, w.from);
  const end = Math.min(i.end, w.to);
  return end > start ? { start, end } : null;
}

/** Seconds of `i` inside `w`. */
export function overlapSeconds(i: Interval, w: TimeWindow): number {
  const c = clip(i, w);
  return c ? (c.end - c.start) / 1000 : 0;
}

/** Merges overlapping intervals (clipped to `w`), sorted by start. */
export function unionIntervals(
  intervals: ReadonlyArray<Interval>,
  w: TimeWindow,
): Interval[] {
  const clipped = intervals
    .map((i) => clip(i, w))
    .filter((i): i is Interval => i !== null)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of clipped) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Length of the union of `intervals` inside `w`, in seconds. */
export function unionSeconds(
  intervals: ReadonlyArray<Interval>,
  w: TimeWindow,
): number {
  return unionIntervals(intervals, w).reduce(
    (s, i) => s + (i.end - i.start) / 1000,
    0,
  );
}

export type JobSpan = {
  startedAt: Date | null;
  completedAt: Date | null;
};

/** The execution interval of a job; open jobs run until `now`. */
export function jobInterval(job: JobSpan, now: number): Interval | null {
  if (!job.startedAt) return null;
  const end = job.completedAt?.getTime() ?? now;
  return end > job.startedAt.getTime()
    ? { start: job.startedAt.getTime(), end }
    : null;
}

/** busyS(r, W) = Σ overlap([startedAt, completedAt], W). Exact. */
export function busySeconds(
  jobs: ReadonlyArray<JobSpan>,
  w: TimeWindow,
  now: number = w.to,
): number {
  let s = 0;
  for (const j of jobs) {
    const i = jobInterval(j, now);
    if (i) s += overlapSeconds(i, w);
  }
  return s;
}

export type SampleRow = {
  sampledAt: Date;
  online: boolean;
  busy: boolean;
  /** Seconds since the previous sample, capped at twice the target interval. */
  intervalS: number;
};

/** The interval a sample stands for: (sampledAt - intervalS, sampledAt]. */
export function sampleInterval(s: SampleRow): Interval {
  const end = s.sampledAt.getTime();
  return { start: end - s.intervalS * 1000, end };
}

/**
 * onlineS(r, W) = the union of the online sample intervals and the runner's
 * job intervals inside W (a runner running a job is online, which also covers
 * ephemeral runners that never appear in a sample).
 */
export function onlineSeconds(
  samples: ReadonlyArray<SampleRow>,
  jobs: ReadonlyArray<JobSpan>,
  w: TimeWindow,
  now: number = w.to,
): number {
  const intervals: Interval[] = [];
  for (const s of samples)
    if (s.online && s.intervalS > 0) intervals.push(sampleInterval(s));
  for (const j of jobs) {
    const i = jobInterval(j, now);
    if (i) intervals.push(i);
  }
  return unionSeconds(intervals, w);
}

export type Utilisation = {
  busyS: number;
  onlineS: number;
  windowS: number;
  /** onlineS / windowS. */
  coverage: number;
  /** busyS / onlineS capped at 1; null when samples are insufficient. */
  value: number | null;
  insufficientSamples: boolean;
};

/**
 * utilisation = busyS / onlineS (capped at 1). When the online time covers
 * less than half the window the samples cannot tell "offline" from "not
 * sampled", so the value is withheld ("insufficient samples").
 */
export function utilisation(
  busyS: number,
  onlineS: number,
  windowS: number,
): Utilisation {
  const coverage = windowS > 0 ? Math.min(1, onlineS / windowS) : 0;
  const insufficientSamples = coverage < MIN_SAMPLE_COVERAGE;
  return {
    busyS,
    onlineS,
    windowS,
    coverage,
    value:
      insufficientSamples || onlineS <= 0 ? null : Math.min(1, busyS / onlineS),
    insufficientSamples,
  };
}

/** Median of the sample intervals (the "± one sample interval" shown with utilisation). */
export function medianSampleInterval(
  samples: ReadonlyArray<SampleRow>,
): number | null {
  const values = samples.filter((s) => s.intervalS > 0).map((s) => s.intervalS);
  return percentileExact(values, 0.5);
}

/**
 * intervalS for a new sample: seconds since the previous one, capped at
 * twice the target interval (0 for the first sample of a runner), so a long
 * gap between samples is not counted as online time.
 */
export function nextSampleInterval(
  previous: Date | null,
  now: Date,
  targetIntervalS: number,
): number {
  if (!previous) return 0;
  const s = Math.round((now.getTime() - previous.getTime()) / 1000);
  return Math.max(0, Math.min(s, 2 * targetIntervalS));
}

// ---------- concurrency (§6.5) ----------

export type ConcurrencyJob = {
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  waitingS: number;
};

export type ConcurrencyBucket = {
  /** Bucket start, ISO. */
  t: string;
  running: number;
  queued: number;
  /** Σ overlap / bucket length. */
  runningAvg: number;
  queuedAvg: number;
};

/**
 * Concurrency in 5-minute buckets: Running(t) = jobs with startedAt ≤ t <
 * completedAt, Queued(t) = jobs with createdAt + waitingS ≤ t < startedAt.
 * `running`/`queued` are the values at the bucket start, the averages the
 * overlap of all jobs with the bucket divided by its length.
 */
export function concurrencyTimeline(
  jobs: ReadonlyArray<ConcurrencyJob>,
  w: TimeWindow,
  now: number = w.to,
  bucketS: number = CONCURRENCY_BUCKET_S,
): ConcurrencyBucket[] {
  const step = bucketS * 1000;
  const first = Math.floor(w.from / step) * step;
  const buckets: ConcurrencyBucket[] = [];
  const runs: Interval[] = [];
  const queues: Interval[] = [];
  for (const j of jobs) {
    const run = jobInterval(j, now);
    if (run) runs.push(run);
    const qStart = j.createdAt.getTime() + j.waitingS * 1000;
    const qEnd = j.startedAt?.getTime() ?? (j.completedAt ? qStart : now);
    if (qEnd > qStart) queues.push({ start: qStart, end: qEnd });
  }
  for (let t = first; t < w.to && buckets.length < 10_000; t += step) {
    const b = { from: t, to: t + step };
    const at = (list: Interval[]) =>
      list.filter((i) => i.start <= t && t < i.end).length;
    const avg = (list: Interval[]) =>
      list.reduce((s, i) => s + overlapSeconds(i, b), 0) / bucketS;
    buckets.push({
      t: new Date(t).toISOString(),
      running: at(runs),
      queued: at(queues),
      runningAvg: avg(runs),
      queuedAvg: avg(queues),
    });
  }
  return buckets;
}

/** Highest number of intervals open at the same instant. */
export function peakConcurrency(intervals: ReadonlyArray<Interval>): number {
  const events: Array<[number, number]> = [];
  for (const i of intervals) {
    if (i.end <= i.start) continue;
    events.push([i.start, 1], [i.end, -1]);
  }
  // Ends before starts at the same instant: back-to-back jobs do not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, d] of events) {
    open += d;
    peak = Math.max(peak, open);
  }
  return peak;
}

// ---------- live queue: STUCK and no matching runner (§6.5) ----------

export type QueueRunner = {
  scope: "ORG" | "REPO";
  repositoryId: bigint | null;
  labels: ReadonlyArray<string>;
  online: boolean;
  busy: boolean;
  removedAt: Date | null;
};

export type QueuedJob = {
  repositoryId: bigint;
  labels: ReadonlyArray<string>;
  createdAt: Date;
  waitingS: number;
};

/** True when the runner's labels contain every job label (case-insensitive). */
export function labelsSatisfy(
  runnerLabels: ReadonlyArray<string>,
  jobLabels: ReadonlyArray<string>,
): boolean {
  const have = new Set(normalizeLabels(runnerLabels));
  return normalizeLabels(jobLabels).every((l) => have.has(l));
}

/** Org runners serve every repo; repo runners only their own repo. */
function servesRepo(r: QueueRunner, repositoryId: bigint): boolean {
  return r.scope === "ORG" || r.repositoryId === repositoryId;
}

export type QueueFlags = {
  /** Queued > 15 min for self-hosted labels with no free online matching runner. */
  stuck: boolean;
  /** No runner with matching labels exists at all, online or not. */
  noMatchingRunner: boolean;
  ageS: number;
};

export function queueFlags(
  job: QueuedJob,
  runners: ReadonlyArray<QueueRunner>,
  now: number,
): QueueFlags {
  const ageS = Math.max(0, Math.round((now - job.createdAt.getTime()) / 1000));
  const selfHosted = normalizeLabels(job.labels).includes("self-hosted");
  if (!selfHosted) return { stuck: false, noMatchingRunner: false, ageS };
  const matching = runners.filter(
    (r) =>
      r.removedAt == null &&
      servesRepo(r, job.repositoryId) &&
      labelsSatisfy(r.labels, job.labels),
  );
  const free = matching.some((r) => r.online && !r.busy);
  const queuedFor = now - job.createdAt.getTime() - job.waitingS * 1000;
  return {
    stuck: queuedFor > STUCK_AFTER_MS && !free,
    noMatchingRunner: matching.length === 0,
    ageS,
  };
}

// ---------- speed index, infra failures, comparison (§6.5) ----------

export type RunnerJob = {
  workflowId: bigint | null;
  baseName: string;
  runnerKey: string;
  durationS: number | null;
};

/**
 * Speed index of `runnerKey`: for every (workflowId, baseName) with at least
 * five jobs on this runner and at least two runners overall, ratio =
 * median(duration on r) / median(duration on all runners); the index is the
 * median of the ratios (1.0 average, 0.8 = 20% faster). Null without data.
 */
export function speedIndex(
  jobs: ReadonlyArray<RunnerJob>,
  runnerKey: string,
): number | null {
  const groups = new Map<string, RunnerJob[]>();
  for (const j of jobs) {
    if (j.durationS == null) continue;
    const k = `${j.workflowId ?? 0}\u0000${j.baseName}`;
    const list = groups.get(k) ?? [];
    list.push(j);
    groups.set(k, list);
  }
  const ratios: number[] = [];
  for (const list of groups.values()) {
    const mine = list.filter((j) => j.runnerKey === runnerKey);
    if (mine.length < MIN_COMPARE_SAMPLES) continue;
    if (new Set(list.map((j) => j.runnerKey)).size < 2) continue;
    const own = percentileExact(
      mine.map((j) => j.durationS!),
      0.5,
    );
    const all = percentileExact(
      list.map((j) => j.durationS!),
      0.5,
    );
    if (own == null || all == null || all <= 0) continue;
    ratios.push(own / all);
  }
  return percentileExact(ratios, 0.5);
}

export type InfraFailureInput = {
  conclusion: Conclusion | null;
  durationS: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

/**
 * failure or startup_failure, and either shorter than 10 s or the runner was
 * removed between startedAt and completedAt.
 */
export function isInfraFailure(
  job: InfraFailureInput,
  runnerRemovedAt: Date | null,
): boolean {
  if (job.conclusion !== "FAILURE" && job.conclusion !== "STARTUP_FAILURE")
    return false;
  if (job.durationS != null && job.durationS < 10) return true;
  if (runnerRemovedAt && job.startedAt && job.completedAt) {
    const t = runnerRemovedAt.getTime();
    return t >= job.startedAt.getTime() && t <= job.completedAt.getTime();
  }
  return false;
}

export type CompareJob = {
  workflowId: bigint | null;
  baseName: string;
  runnerKind: RunnerKind;
  durationS: number | null;
  queueS: number | null;
};

export type KindStats = {
  n: number;
  p50: number | null;
  p95: number | null;
  queueP50: number | null;
  queueP95: number | null;
};

export type Comparison = {
  workflowId: bigint | null;
  baseName: string;
  hosted: KindStats;
  selfHosted: KindStats;
  /** (selfHosted p50 - hosted p50) / hosted p50; negative = self-hosted faster. */
  deltaP50: number | null;
  deltaP95: number | null;
};

function kindStats(jobs: ReadonlyArray<CompareJob>): KindStats {
  const d = jobs.map((j) => j.durationS).filter((v): v is number => v != null);
  const q = jobs.map((j) => j.queueS).filter((v): v is number => v != null);
  return {
    n: d.length,
    p50: percentileExact(d, 0.5),
    p95: percentileExact(d, 0.95),
    queueP50: percentileExact(q, 0.5),
    queueP95: percentileExact(q, 0.95),
  };
}

const delta = (a: number | null, b: number | null) =>
  a == null || b == null || b === 0 ? null : (a - b) / b;

/**
 * Hosted vs self-hosted: every (workflowId, baseName) with at least five
 * timed jobs on both kinds, p50/p95 duration and queue side by side.
 * Hosted includes larger hosted runners.
 */
export function compareHostedSelfHosted(
  jobs: ReadonlyArray<CompareJob>,
): Comparison[] {
  const groups = new Map<
    string,
    { hosted: CompareJob[]; self: CompareJob[] }
  >();
  for (const j of jobs) {
    if (j.runnerKind === "UNKNOWN") continue;
    const k = `${j.workflowId ?? 0}\u0000${j.baseName}`;
    const g = groups.get(k) ?? { hosted: [], self: [] };
    (j.runnerKind === "SELF_HOSTED" ? g.self : g.hosted).push(j);
    groups.set(k, g);
  }
  const out: Comparison[] = [];
  for (const g of groups.values()) {
    const hosted = kindStats(g.hosted);
    const selfHosted = kindStats(g.self);
    if (hosted.n < MIN_COMPARE_SAMPLES || selfHosted.n < MIN_COMPARE_SAMPLES)
      continue;
    const first = g.hosted[0] ?? g.self[0]!;
    out.push({
      workflowId: first.workflowId,
      baseName: first.baseName,
      hosted,
      selfHosted,
      deltaP50: delta(selfHosted.p50, hosted.p50),
      deltaP95: delta(selfHosted.p95, hosted.p95),
    });
  }
  return out.sort((a, b) => a.baseName.localeCompare(b.baseName));
}
