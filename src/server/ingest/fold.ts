import {
  baseNameOf,
  classifyRunner,
  labelKeyOf,
  normalizeLabels,
  runnerOsOf,
  skuOf,
  type RunnerKind,
  type RunnerOs,
  type SkuRateLike,
} from "@/server/metrics/classify";
import { estimateJobCost } from "@/server/metrics/cost";
import {
  executionSeconds,
  queueSeconds,
  type Conclusion,
} from "@/server/metrics/stats";

/**
 * Order-independent, idempotent folds for workflow jobs and runs (design
 * §5.2). Pure functions: `fold(fold(row, a), b) === fold(fold(row, b), a)` and
 * `fold(fold(row, a), a) === fold(row, a)` for every pair of events of the
 * same job or run, so webhooks, redeliveries, reconcile and backfill can
 * apply events in any order and any number of times.
 *
 * Every field is merged as the maximum of a total order (or a minimum), which
 * makes the fold a join in a semilattice:
 * - status and conclusion: by status rank, then conclusion; for runs the
 *   attempt comes first, so a newer attempt resets them.
 * - timestamps that GitHub sets once per phase: taken only from events of
 *   that phase (startedAt from in_progress/completed, completedAt from
 *   completed), min or max so ties are deterministic.
 * - descriptive fields: a real event beats a placeholder, a value beats
 *   null, ties go to the larger value.
 * Derived columns (queue, duration, runner kind, OS, SKU, minutes) are
 * recomputed from the merged row on every fold.
 */

export type Source = "WEBHOOK" | "BACKFILL" | "RECONCILE";
export type JobStatus = "QUEUED" | "WAITING" | "IN_PROGRESS" | "COMPLETED";
export type RunStatus =
  "REQUESTED" | "QUEUED" | "WAITING" | "PENDING" | "IN_PROGRESS" | "COMPLETED";

export const JOB_STATUS_RANK: Record<JobStatus, number> = {
  QUEUED: 1,
  WAITING: 2,
  IN_PROGRESS: 3,
  COMPLETED: 4,
};

export const RUN_STATUS_RANK: Record<RunStatus, number> = {
  REQUESTED: 1,
  QUEUED: 1,
  PENDING: 1,
  WAITING: 2,
  IN_PROGRESS: 3,
  COMPLETED: 4,
};

/** Placeholder runs rank below every real status. */
export const PLACEHOLDER_RANK = 0;

const SOURCE_ORDER: Record<Source, number> = {
  BACKFILL: 1,
  RECONCILE: 2,
  WEBHOOK: 3,
};

// ---------- merge helpers ----------

type Comparable = string | number | bigint | boolean;

function cmp(a: Comparable, b: Comparable): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Larger non-null value; null only when both are null. */
function maxOf<T extends Comparable>(a: T | null, b: T | null): T | null {
  if (a == null) return b;
  if (b == null) return a;
  return cmp(a, b) >= 0 ? a : b;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

const CONCLUSION_ORDER: Record<Conclusion, number> = {
  SUCCESS: 1,
  NEUTRAL: 2,
  SKIPPED: 3,
  STALE: 4,
  ACTION_REQUIRED: 5,
  CANCELLED: 6,
  TIMED_OUT: 7,
  STARTUP_FAILURE: 8,
  FAILURE: 9,
};

/** Status key: rank first, then a conclusion beats none, then a fixed order. */
function statusKey(rank: number, conclusion: Conclusion | null): number {
  return rank * 100 + (conclusion ? CONCLUSION_ORDER[conclusion] : 0);
}

function maxSource(a: Source, b: Source): Source {
  return SOURCE_ORDER[a] >= SOURCE_ORDER[b] ? a : b;
}

const secondsBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

// ---------- jobs ----------

/** One observation of a job: a webhook delivery or a REST snapshot. */
export type JobEvent = {
  id: bigint;
  runId: bigint;
  runAttempt: number;
  installationId: bigint;
  repositoryId: bigint;
  workflowName: string;
  name: string;
  labels: string[];
  status: JobStatus;
  conclusion: Conclusion | null;
  runnerId: bigint | null;
  runnerName: string | null;
  runnerGroupId: bigint | null;
  runnerGroupName: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** When the event was observed: delivery receivedAt, or the REST fetch time. */
  eventAt: Date;
  source: Source;
};

export type JobRow = {
  id: bigint;
  runId: bigint;
  runAttempt: number;
  installationId: bigint;
  repositoryId: bigint;
  workflowId: bigint | null;
  workflowName: string;
  name: string;
  baseName: string;
  labels: string[];
  labelKey: string;
  status: JobStatus;
  statusRank: number;
  conclusion: Conclusion | null;
  runnerId: bigint | null;
  runnerName: string | null;
  runnerGroupId: bigint | null;
  runnerGroupName: string | null;
  runnerKind: RunnerKind;
  runnerOs: RunnerOs;
  sku: string | null;
  createdAt: Date;
  waitingStartedAt: Date | null;
  lastQueuedAt: Date | null;
  waitingS: number;
  startedAt: Date | null;
  completedAt: Date | null;
  queueS: number | null;
  durationS: number | null;
  billableMinEst: number | null;
  source: Source;
  lastEventAt: Date;
};

export type FoldContext = {
  rates: ReadonlyArray<SkuRateLike>;
  repoPrivate: boolean;
};

/** Approval wait: from the first `waiting` to the next queued/start/finish. */
function approvalWait(row: {
  waitingStartedAt: Date | null;
  lastQueuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}): number {
  const from = row.waitingStartedAt;
  if (!from) return 0;
  const ends = [row.lastQueuedAt, row.startedAt, row.completedAt]
    .filter((d): d is Date => d != null && d.getTime() > from.getTime())
    .map((d) => d.getTime());
  if (ends.length === 0) return 0;
  return secondsBetween(from, new Date(Math.min(...ends)));
}

/** Recomputes the derived columns of a merged job row. */
export function deriveJob(
  base: Omit<
    JobRow,
    | "baseName"
    | "labelKey"
    | "runnerKind"
    | "runnerOs"
    | "sku"
    | "waitingS"
    | "queueS"
    | "durationS"
    | "billableMinEst"
  >,
  ctx: FoldContext,
): JobRow {
  const runnerKind = classifyRunner(
    {
      labels: base.labels,
      runnerName: base.runnerName,
      runnerGroupName: base.runnerGroupName,
    },
    ctx.rates,
  );
  const runnerOs = runnerOsOf(base.labels, base.runnerName);
  const sku = skuOf(runnerKind, runnerOs, base.labels, ctx.rates);
  const waitingS = approvalWait(base);
  const times = { ...base, waitingS };
  const durationS = executionSeconds(base);
  const cost = estimateJobCost(
    {
      kind: runnerKind,
      sku,
      durationS,
      repoPrivate: ctx.repoPrivate,
      day: base.startedAt ?? base.createdAt,
    },
    ctx.rates,
  );
  return {
    ...base,
    baseName: baseNameOf(base.name),
    labelKey: labelKeyOf(base.labels),
    runnerKind,
    runnerOs,
    sku,
    waitingS,
    queueS: queueSeconds(times),
    durationS,
    billableMinEst: cost?.billableMinEst ?? null,
  };
}

function jobEventAsRow(ev: JobEvent): Parameters<typeof deriveJob>[0] {
  const rank = JOB_STATUS_RANK[ev.status];
  return {
    id: ev.id,
    runId: ev.runId,
    runAttempt: ev.runAttempt,
    installationId: ev.installationId,
    repositoryId: ev.repositoryId,
    workflowId: null,
    workflowName: ev.workflowName,
    name: ev.name,
    labels: normalizeLabels(ev.labels),
    status: ev.status,
    statusRank: rank,
    conclusion: rank === 4 ? ev.conclusion : null,
    // Runner and start time are only trusted once the job has started:
    // GitHub fills started_at with the queue time while a job is queued.
    runnerId: rank >= 3 ? ev.runnerId : null,
    runnerName: rank >= 3 ? ev.runnerName || null : null,
    runnerGroupId: rank >= 3 ? ev.runnerGroupId : null,
    runnerGroupName: rank >= 3 ? ev.runnerGroupName || null : null,
    createdAt: ev.createdAt,
    waitingStartedAt: ev.status === "WAITING" ? ev.eventAt : null,
    lastQueuedAt: ev.status === "QUEUED" ? ev.eventAt : null,
    startedAt: rank >= 3 ? ev.startedAt : null,
    completedAt: rank === 4 ? ev.completedAt : null,
    source: ev.source,
    lastEventAt: ev.eventAt,
  };
}

function pickLabels(a: string[], b: string[]): string[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  // Labels never change for a job; if they ever differ, pick deterministically.
  return a.join(",") <= b.join(",") ? a : b;
}

export function foldJob(
  prev: JobRow | null,
  ev: JobEvent,
  ctx: FoldContext,
): JobRow {
  const next = jobEventAsRow(ev);
  if (!prev) return deriveJob(next, ctx);

  const prevKey = statusKey(prev.statusRank, prev.conclusion);
  const nextKey = statusKey(next.statusRank, next.conclusion);
  const status = nextKey > prevKey ? next : prev;

  return deriveJob(
    {
      id: prev.id,
      runId: maxOf(prev.runId, next.runId)!,
      runAttempt: Math.max(prev.runAttempt, next.runAttempt),
      installationId: prev.installationId,
      repositoryId: prev.repositoryId,
      workflowId: prev.workflowId,
      workflowName: maxOf(prev.workflowName, next.workflowName)!,
      name: maxOf(prev.name, next.name)!,
      labels: pickLabels(prev.labels, next.labels),
      status: status.status,
      statusRank: status.statusRank,
      conclusion: status.conclusion,
      runnerId: maxOf(prev.runnerId, next.runnerId),
      runnerName: maxOf(prev.runnerName, next.runnerName),
      runnerGroupId: maxOf(prev.runnerGroupId, next.runnerGroupId),
      runnerGroupName: maxOf(prev.runnerGroupName, next.runnerGroupName),
      createdAt: minDate(prev.createdAt, next.createdAt)!,
      waitingStartedAt: minDate(prev.waitingStartedAt, next.waitingStartedAt),
      lastQueuedAt: maxDate(prev.lastQueuedAt, next.lastQueuedAt),
      startedAt: maxDate(prev.startedAt, next.startedAt),
      completedAt: maxDate(prev.completedAt, next.completedAt),
      source: maxSource(prev.source, next.source),
      lastEventAt: maxDate(prev.lastEventAt, next.lastEventAt)!,
    },
    ctx,
  );
}

// ---------- runs ----------

export type RunEvent = {
  id: bigint;
  installationId: bigint;
  repositoryId: bigint;
  workflowId: bigint | null;
  workflowName: string;
  workflowPath: string | null;
  event: string | null;
  headBranch: string | null;
  headSha: string;
  isDefaultBranch: boolean;
  actorLogin: string | null;
  runNumber: number | null;
  runAttempt: number;
  status: RunStatus;
  conclusion: Conclusion | null;
  createdAt: Date;
  runStartedAt: Date | null;
  /** GitHub's updated_at; the completion time when the status is completed. */
  updatedAt: Date | null;
  htmlUrl: string | null;
  /** Built from a job before the run itself was seen. */
  placeholder: boolean;
  eventAt: Date;
  source: Source;
};

export type RunRow = {
  id: bigint;
  installationId: bigint;
  repositoryId: bigint;
  workflowId: bigint | null;
  workflowName: string;
  workflowPath: string | null;
  event: string | null;
  headBranch: string | null;
  headSha: string;
  isDefaultBranch: boolean;
  actorLogin: string | null;
  runNumber: number | null;
  runAttempt: number;
  firstAttemptConclusion: Conclusion | null;
  status: RunStatus;
  statusRank: number;
  conclusion: Conclusion | null;
  createdAt: Date;
  runStartedAt: Date | null;
  completedAt: Date | null;
  durationS: number | null;
  isPlaceholder: boolean;
  htmlUrl: string | null;
  githubUpdatedAt: Date | null;
  jobsSyncedAt: Date | null;
  source: Source;
  lastEventAt: Date;
};

function runEventAsRow(ev: RunEvent): Omit<RunRow, "durationS"> {
  const rank = ev.placeholder ? PLACEHOLDER_RANK : RUN_STATUS_RANK[ev.status];
  const completed = rank === 4;
  return {
    id: ev.id,
    installationId: ev.installationId,
    repositoryId: ev.repositoryId,
    workflowId: ev.workflowId,
    workflowName: ev.workflowName,
    workflowPath: ev.workflowPath,
    event: ev.event,
    headBranch: ev.headBranch,
    headSha: ev.headSha,
    isDefaultBranch: ev.isDefaultBranch,
    actorLogin: ev.actorLogin,
    runNumber: ev.runNumber,
    runAttempt: ev.runAttempt,
    firstAttemptConclusion:
      completed && ev.runAttempt === 1 ? ev.conclusion : null,
    status: ev.placeholder ? "QUEUED" : ev.status,
    statusRank: rank,
    conclusion: completed ? ev.conclusion : null,
    createdAt: ev.createdAt,
    runStartedAt: ev.placeholder ? null : ev.runStartedAt,
    completedAt: completed ? ev.updatedAt : null,
    isPlaceholder: ev.placeholder,
    htmlUrl: ev.htmlUrl,
    githubUpdatedAt: ev.placeholder ? null : ev.updatedAt,
    jobsSyncedAt: null,
    source: ev.source,
    lastEventAt: ev.eventAt,
  };
}

function withDuration(row: Omit<RunRow, "durationS">): RunRow {
  return {
    ...row,
    durationS:
      row.completedAt && row.runStartedAt
        ? secondsBetween(row.runStartedAt, row.completedAt)
        : null,
  };
}

/** Several run statuses share rank 1; a fixed sub-order keeps ties deterministic. */
const RUN_STATUS_ORDER: Record<RunStatus, number> = {
  REQUESTED: 0,
  PENDING: 1,
  QUEUED: 2,
  WAITING: 0,
  IN_PROGRESS: 0,
  COMPLETED: 0,
};

function runStatusKey(row: {
  status: RunStatus;
  statusRank: number;
  conclusion: Conclusion | null;
}): number {
  return (
    statusKey(row.statusRank, row.conclusion) * 10 +
    RUN_STATUS_ORDER[row.status]
  );
}

/** Descriptive field: a real event beats a placeholder, then max(value). */
function pickDescriptive<T extends Comparable>(
  a: T | null,
  aStrong: boolean,
  b: T | null,
  bStrong: boolean,
): T | null {
  if (aStrong !== bStrong) return aStrong ? a : b;
  return maxOf(a, b);
}

export function foldRun(prev: RunRow | null, ev: RunEvent): RunRow {
  const next = runEventAsRow(ev);
  if (!prev) return withDuration(next);

  // Attempt-scoped fields follow the newest attempt; within one attempt they
  // merge by status key and min/max.
  let attempt: Pick<
    RunRow,
    | "runAttempt"
    | "status"
    | "statusRank"
    | "conclusion"
    | "runStartedAt"
    | "completedAt"
  >;
  if (next.runAttempt !== prev.runAttempt) {
    const newer = next.runAttempt > prev.runAttempt ? next : prev;
    attempt = {
      runAttempt: newer.runAttempt,
      status: newer.status,
      statusRank: newer.statusRank,
      conclusion: newer.conclusion,
      runStartedAt: newer.runStartedAt,
      completedAt: newer.completedAt,
    };
  } else {
    const winner = runStatusKey(next) > runStatusKey(prev) ? next : prev;
    attempt = {
      runAttempt: prev.runAttempt,
      status: winner.status,
      statusRank: winner.statusRank,
      conclusion: winner.conclusion,
      runStartedAt: maxDate(prev.runStartedAt, next.runStartedAt),
      completedAt: minDate(prev.completedAt, next.completedAt),
    };
  }

  const a = !prev.isPlaceholder;
  const b = !next.isPlaceholder;
  const d = <T extends Comparable>(x: T | null, y: T | null) =>
    pickDescriptive(x, a, y, b);

  return withDuration({
    id: prev.id,
    installationId: prev.installationId,
    repositoryId: prev.repositoryId,
    workflowId: d(prev.workflowId, next.workflowId),
    workflowName: d(prev.workflowName, next.workflowName)!,
    workflowPath: d(prev.workflowPath, next.workflowPath),
    event: d(prev.event, next.event),
    headBranch: d(prev.headBranch, next.headBranch),
    headSha: d(prev.headSha, next.headSha)!,
    isDefaultBranch: d(prev.isDefaultBranch, next.isDefaultBranch) ?? false,
    actorLogin: d(prev.actorLogin, next.actorLogin),
    runNumber: d(prev.runNumber, next.runNumber),
    htmlUrl: d(prev.htmlUrl, next.htmlUrl),
    ...attempt,
    firstAttemptConclusion: maxOf(
      prev.firstAttemptConclusion,
      next.firstAttemptConclusion,
    ),
    createdAt: minDate(prev.createdAt, next.createdAt)!,
    isPlaceholder: !(a || b),
    githubUpdatedAt: maxDate(prev.githubUpdatedAt, next.githubUpdatedAt),
    jobsSyncedAt: prev.jobsSyncedAt,
    source: maxSource(prev.source, next.source),
    lastEventAt: maxDate(prev.lastEventAt, next.lastEventAt)!,
  });
}

/** A weak run event built from a job, so a job never waits for its run. */
export function placeholderRunEvent(
  job: JobEvent,
  extra: { headSha: string; headBranch: string | null },
): RunEvent {
  return {
    id: job.runId,
    installationId: job.installationId,
    repositoryId: job.repositoryId,
    workflowId: null,
    workflowName: job.workflowName,
    workflowPath: null,
    event: null,
    headBranch: extra.headBranch,
    headSha: extra.headSha,
    isDefaultBranch: false,
    actorLogin: null,
    runNumber: null,
    runAttempt: job.runAttempt,
    status: "QUEUED",
    conclusion: null,
    createdAt: job.createdAt,
    runStartedAt: null,
    updatedAt: null,
    htmlUrl: null,
    placeholder: true,
    eventAt: job.eventAt,
    source: job.source,
  };
}
