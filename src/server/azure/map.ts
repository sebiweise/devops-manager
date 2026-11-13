import type {
  AzureBuildRaw,
  AzureJobRequestInfo,
  AzureTimelineRecord,
} from "./client";
import { toDate } from "./client";

/**
 * Pure mapping of Azure DevOps builds and timeline records to the stored
 * rows (design addendum M7 §4.3 "Mapping notes"). No identity, e-mail
 * address or log text survives: the client schemas already dropped them,
 * and these mappers copy whitelisted fields only.
 */

export type BuildStatus =
  | "NOT_STARTED"
  | "POSTPONED"
  | "IN_PROGRESS"
  | "CANCELLING"
  | "COMPLETED"
  | "UNKNOWN";
export type BuildResult =
  "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED" | "CANCELED" | "NONE";
export type JobResult =
  | "SUCCEEDED"
  | "SUCCEEDED_WITH_ISSUES"
  | "FAILED"
  | "CANCELED"
  | "SKIPPED"
  | "ABANDONED"
  | "NONE";
export type Os = "LINUX" | "WINDOWS" | "MACOS" | "UNKNOWN";

export function buildStatusOf(v: string | null | undefined): BuildStatus {
  switch (v) {
    case "notStarted":
      return "NOT_STARTED";
    case "postponed":
      return "POSTPONED";
    case "inProgress":
      return "IN_PROGRESS";
    case "cancelling":
      return "CANCELLING";
    case "completed":
      return "COMPLETED";
    default:
      return "UNKNOWN";
  }
}

export function buildResultOf(v: string | null | undefined): BuildResult {
  switch (v) {
    case "succeeded":
      return "SUCCEEDED";
    case "partiallySucceeded":
      return "PARTIALLY_SUCCEEDED";
    case "failed":
      return "FAILED";
    case "canceled":
      return "CANCELED";
    default:
      return "NONE";
  }
}

export function jobResultOf(v: string | null | undefined): JobResult {
  switch (v) {
    case "succeeded":
      return "SUCCEEDED";
    case "succeededWithIssues":
      return "SUCCEEDED_WITH_ISSUES";
    case "failed":
      return "FAILED";
    case "canceled":
      return "CANCELED";
    case "skipped":
      return "SKIPPED";
    case "abandoned":
      return "ABANDONED";
    default:
      return "NONE";
  }
}

/** `reason` to the event names of the GitHub views (never a user name). */
export function eventOf(reason: string | null | undefined): string {
  switch (reason) {
    case "individualCI":
    case "batchedCI":
      return "push";
    case "pullRequest":
      return "pull_request";
    case "schedule":
    case "scheduleForced":
      return "schedule";
    case "manual":
    case "userCreated":
      return "workflow_dispatch";
    case "buildCompletion":
    case "resourceTrigger":
      return "pipeline_trigger";
    default:
      return "other";
  }
}

/** OS from a hosted image name, an agent OS description or a job name. */
export function osOf(...hints: ReadonlyArray<string | null | undefined>): Os {
  for (const h of hints) {
    if (!h) continue;
    if (/mac|darwin|osx/i.test(h)) return "MACOS";
    if (/win|vs20\d\d/i.test(h)) return "WINDOWS";
    if (/ubuntu|linux|debian|alpine/i.test(h)) return "LINUX";
  }
  return "UNKNOWN";
}

const SHA = /^[0-9a-f]{40}$/i;
const stripRef = (ref: string) =>
  ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "tags/");

export type BuildRow = {
  id: number;
  projectId: string;
  definitionId: number;
  buildNumber: string;
  status: BuildStatus;
  result: BuildResult;
  reason: string;
  /** The raw reason, e.g. "manual" (probable audit links). */
  rawReason: string | null;
  headBranch: string | null;
  headSha: string | null;
  prNumber: number | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationS: number | null;
  queuePosition: number | null;
  lastChangedAt: Date | null;
  /** The dm-audit-<id> tag of an M7b queue, if any. */
  auditTag: string | null;
  /** refs/heads/... as sent (probable audit links). */
  sourceRef: string | null;
};

const AUDIT_TAG =
  /^dm-audit-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The audit id of a `dm-audit-<uuid>` tag. */
export function auditIdOfTag(tag: string): string | null {
  const m = AUDIT_TAG.exec(tag);
  return m ? m[1]!.toLowerCase() : null;
}

export function auditTagOf(auditId: string): string {
  return `dm-audit-${auditId.toLowerCase()}`;
}

export function mapBuild(b: AzureBuildRaw, projectId: string): BuildRow | null {
  const queuedAt = toDate(b.queueTime);
  const definitionId = b.definition?.id;
  if (!queuedAt || definitionId == null) return null;
  const t = b.triggerInfo ?? null;
  const prNumber =
    t?.prNumber && /^\d{1,9}$/.test(t.prNumber)
      ? Number(t.prNumber)
      : (() => {
          const m = /^refs\/pull\/(\d{1,9})\/merge$/.exec(b.sourceBranch ?? "");
          return m ? Number(m[1]) : null;
        })();
  // PR builds build a merge commit; the PR's head is triggerInfo pr.sourceSha (verify).
  const sha =
    t?.prSourceSha && SHA.test(t.prSourceSha)
      ? t.prSourceSha
      : b.sourceVersion && SHA.test(b.sourceVersion)
        ? b.sourceVersion
        : null;
  const branchRef =
    prNumber != null && t?.prSourceBranch
      ? t.prSourceBranch
      : (b.sourceBranch ?? null);
  const startedAt = toDate(b.startTime);
  const finishedAt = toDate(b.finishTime);
  const status = buildStatusOf(b.status);
  return {
    id: b.id,
    projectId: (b.project?.id ?? projectId).toLowerCase(),
    definitionId,
    buildNumber: (b.buildNumber ?? String(b.id)).slice(0, 100),
    status,
    result: status === "COMPLETED" ? buildResultOf(b.result) : "NONE",
    reason: eventOf(b.reason),
    rawReason: b.reason ?? null,
    headBranch: branchRef ? stripRef(branchRef).slice(0, 255) : null,
    headSha: sha ? sha.toLowerCase() : null,
    prNumber,
    queuedAt,
    startedAt,
    finishedAt,
    durationS:
      startedAt && finishedAt && finishedAt >= startedAt
        ? Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)
        : null,
    queuePosition: b.queuePosition ?? null,
    lastChangedAt: toDate(b.lastChangedDate),
    auditTag:
      (b.tags ?? []).map(auditIdOfTag).find((x): x is string => !!x) ?? null,
    sourceRef: b.sourceBranch ?? null,
  };
}

/** A record name without the matrix and attempt suffixes. */
export function baseNameOf(name: string): string {
  return name.replace(/\s*\((?:attempt #?\d+|[^)]*)\)\s*$/i, "").trim() || name;
}

/**
 * The job hit the job time limit: it was canceled or failed, ran at least
 * the cap minus 30 s, and (verify) an issue names the time limit; a
 * cancellation at the cap counts even without the issue text.
 */
const CAP_TEXT =
  /(ran longer than the maximum time|maximum (execution|job) time|exceeded the (maximum )?(execution |job )?time|timed? ?out|has (been )?(canceled|cancelled) (after|because)|time limit)/i;

export function hitJobCap(
  rec: Pick<AzureTimelineRecord, "result" | "issues">,
  durationS: number | null,
  maxJobMinutes: number,
): boolean {
  if (rec.result !== "canceled" && rec.result !== "failed") return false;
  if (durationS == null || durationS < maxJobMinutes * 60 - 30) return false;
  const texts = (rec.issues ?? []).map((i) => i.message ?? "");
  return rec.result === "canceled" || texts.some((t) => CAP_TEXT.test(t));
}

export type JobRow = {
  recordId: string;
  attempt: number;
  type: "Job" | "Stage";
  identifier: string | null;
  stageIdentifier: string | null;
  name: string;
  baseName: string;
  state: string;
  result: JobResult;
  workerName: string | null;
  logId: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationS: number | null;
  hitJobCap: boolean;
  isHosted: boolean | null;
  os: Os;
  queueId: number | null;
};

/** Worker names of Microsoft-hosted agents (verify). */
export function isHostedWorker(
  name: string | null | undefined,
): boolean | null {
  if (!name) return null;
  return /^(Hosted Agent|Azure Pipelines( \d+)?|Azure Pipelines .*)$/i.test(
    name,
  );
}

/**
 * The Job and Stage records of one timeline as rows. `attemptOverride` is
 * used for the records of a previous-attempt timeline, whose own `attempt`
 * may be missing.
 */
export function mapTimeline(
  records: ReadonlyArray<AzureTimelineRecord>,
  maxJobMinutes: number,
  attemptOverride?: number,
): JobRow[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const stageOf = (r: AzureTimelineRecord): AzureTimelineRecord | null => {
    let cur: AzureTimelineRecord | undefined = r;
    for (let i = 0; i < 5 && cur; i++) {
      if (cur.type === "Stage") return cur;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return null;
  };
  const out: JobRow[] = [];
  for (const r of records) {
    if (r.type !== "Job" && r.type !== "Stage") continue;
    const startedAt = toDate(r.startTime);
    const finishedAt = toDate(r.finishTime);
    const durationS =
      startedAt && finishedAt && finishedAt >= startedAt
        ? Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)
        : null;
    const name = (r.name ?? r.identifier ?? r.id).slice(0, 200);
    const stage = r.type === "Job" ? stageOf(r) : null;
    out.push({
      recordId: r.id.toLowerCase(),
      attempt: attemptOverride ?? Math.max(1, r.attempt ?? 1),
      type: r.type,
      identifier: r.identifier ? r.identifier.slice(0, 200) : null,
      stageIdentifier:
        r.type === "Stage"
          ? (r.identifier ?? null)
          : (stage?.identifier ?? null),
      name,
      baseName: baseNameOf(name).slice(0, 200),
      state: r.state ?? "pending",
      result: jobResultOf(r.result),
      workerName: r.workerName ? r.workerName.slice(0, 200) : null,
      logId: r.log?.id ?? null,
      startedAt,
      finishedAt,
      durationS,
      hitJobCap: r.type === "Job" && hitJobCap(r, durationS, maxJobMinutes),
      isHosted: r.type === "Job" ? isHostedWorker(r.workerName) : null,
      os: r.type === "Job" ? osOf(r.workerName, name) : "UNKNOWN",
      queueId: r.queueId ?? null,
    });
  }
  return out;
}

/** Previous-attempt timelines to read: (attempt, timelineId) per Job record. */
export function previousTimelines(
  records: ReadonlyArray<AzureTimelineRecord>,
): Array<{ attempt: number; timelineId: string }> {
  const seen = new Map<string, number>();
  for (const r of records) {
    if (r.type !== "Job" && r.type !== "Stage") continue;
    for (const p of r.previousAttempts ?? []) {
      if (p.timelineId && !seen.has(p.timelineId))
        seen.set(p.timelineId, p.attempt);
    }
  }
  return [...seen.entries()]
    .map(([timelineId, attempt]) => ({ attempt, timelineId }))
    .sort((a, b) => a.attempt - b.attempt);
}

export type BuildDerived = {
  maxAttempt: number;
  firstAttemptResult: BuildResult | null;
  timedOut: boolean;
  /** First job start minus queue time. */
  queueS: number | null;
};

const FAILED_JOB: ReadonlySet<JobResult> = new Set([
  "FAILED",
  "CANCELED",
  "ABANDONED",
]);

/**
 * maxAttempt, the result of attempt 1 and timed-out from the job rows of
 * every attempt (design addendum §4.3 "First attempt"). Without a retry the
 * first attempt is the build's own result.
 */
export function deriveBuild(
  build: { result: BuildResult; status: BuildStatus; queuedAt: Date },
  jobs: ReadonlyArray<JobRow>,
): BuildDerived {
  const jobRows = jobs.filter((j) => j.type === "Job");
  const maxAttempt = Math.max(1, ...jobRows.map((j) => j.attempt));
  let firstAttemptResult: BuildResult | null = null;
  if (build.status === "COMPLETED") {
    if (maxAttempt === 1) firstAttemptResult = build.result;
    else {
      const first = jobRows.filter((j) => j.attempt === 1);
      // A job retried later had failed in attempt 1 even when its attempt-1
      // record is not readable any more.
      const retried = new Set(
        jobRows.filter((j) => j.attempt > 1).map((j) => j.identifier ?? j.name),
      );
      firstAttemptResult =
        first.some((j) => FAILED_JOB.has(j.result)) || retried.size > 0
          ? "FAILED"
          : "SUCCEEDED";
    }
  }
  const starts = jobRows
    .filter((j) => j.attempt === 1 && j.startedAt)
    .map((j) => j.startedAt!.getTime());
  const firstStart = starts.length > 0 ? Math.min(...starts) : null;
  return {
    maxAttempt,
    firstAttemptResult,
    timedOut: jobRows.some((j) => j.hitJobCap),
    queueS:
      firstStart != null
        ? Math.max(
            0,
            Math.round((firstStart - build.queuedAt.getTime()) / 1000),
          )
        : null,
  };
}

/** Billed minutes of one hosted job: started minutes, rounded up per job (verify). */
export function jobMinutes(assign: Date | null, finish: Date | null): number {
  if (!assign || !finish || finish <= assign) return 0;
  return Math.ceil((finish.getTime() - assign.getTime()) / 60_000);
}

/** The OS of a job request (hosted image first). */
export function requestOs(r: Pick<AzureJobRequestInfo, "image">): Os {
  return osOf(r.image);
}
