import type { Conclusion } from "@/server/metrics/stats";
import type { JobEvent, JobStatus, RunEvent, RunStatus, Source } from "./fold";

/**
 * Maps GitHub workflow job and run objects (webhook payloads and REST
 * responses share the same shape) to fold events. Unknown statuses and
 * conclusions map to safe defaults instead of failing the delivery.
 */

export type GhWorkflowJob = {
  id: number;
  run_id: number;
  run_attempt?: number;
  workflow_name?: string | null;
  head_branch?: string | null;
  head_sha: string;
  name: string;
  labels?: string[];
  status: string;
  conclusion?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  runner_id?: number | null;
  runner_name?: string | null;
  runner_group_id?: number | null;
  runner_group_name?: string | null;
};

export type GhWorkflowRun = {
  id: number;
  workflow_id?: number | null;
  name?: string | null;
  path?: string | null;
  event?: string | null;
  head_branch?: string | null;
  head_sha: string;
  actor?: { login: string } | null;
  run_number?: number | null;
  run_attempt?: number | null;
  status: string | null;
  conclusion?: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  repository?: { id: number; default_branch?: string };
};

export type WorkflowJobPayload = {
  action?: string;
  workflow_job: GhWorkflowJob;
  repository: {
    id: number;
    full_name: string;
    name: string;
    private: boolean;
    default_branch?: string;
  };
  installation?: { id: number };
};

export type WorkflowRunPayload = {
  action?: string;
  workflow_run: GhWorkflowRun;
  repository: {
    id: number;
    full_name: string;
    name: string;
    private: boolean;
    default_branch?: string;
  };
  installation?: { id: number };
};

const CONCLUSIONS: Record<string, Conclusion> = {
  success: "SUCCESS",
  failure: "FAILURE",
  cancelled: "CANCELLED",
  skipped: "SKIPPED",
  timed_out: "TIMED_OUT",
  action_required: "ACTION_REQUIRED",
  neutral: "NEUTRAL",
  stale: "STALE",
  startup_failure: "STARTUP_FAILURE",
};

export function mapConclusion(value: string | null | undefined) {
  if (!value) return null;
  return CONCLUSIONS[value.toLowerCase()] ?? "NEUTRAL";
}

export function mapJobStatus(value: string | null | undefined): JobStatus {
  switch ((value ?? "").toLowerCase()) {
    case "waiting":
      return "WAITING";
    case "in_progress":
      return "IN_PROGRESS";
    case "completed":
      return "COMPLETED";
    default:
      // queued, requested, pending
      return "QUEUED";
  }
}

export function mapRunStatus(value: string | null | undefined): RunStatus {
  switch ((value ?? "").toLowerCase()) {
    case "requested":
      return "REQUESTED";
    case "pending":
      return "PENDING";
    case "waiting":
      return "WAITING";
    case "in_progress":
      return "IN_PROGRESS";
    case "completed":
      return "COMPLETED";
    default:
      return "QUEUED";
  }
}

const date = (v: string | null | undefined) => (v ? new Date(v) : null);
const big = (v: number | null | undefined) => (v == null ? null : BigInt(v));

export function jobEventFrom(
  job: GhWorkflowJob,
  ctx: {
    installationId: bigint;
    repositoryId: bigint;
    eventAt: Date;
    source: Source;
  },
): JobEvent {
  return {
    id: BigInt(job.id),
    runId: BigInt(job.run_id),
    runAttempt: job.run_attempt ?? 1,
    installationId: ctx.installationId,
    repositoryId: ctx.repositoryId,
    workflowName: job.workflow_name ?? "",
    name: job.name,
    labels: job.labels ?? [],
    status: mapJobStatus(job.status),
    conclusion: mapConclusion(job.conclusion),
    runnerId: job.runner_id ? BigInt(job.runner_id) : null,
    runnerName: job.runner_name || null,
    runnerGroupId: job.runner_group_id ? BigInt(job.runner_group_id) : null,
    runnerGroupName: job.runner_group_name || null,
    createdAt: new Date(job.created_at),
    startedAt: date(job.started_at),
    completedAt: date(job.completed_at),
    eventAt: ctx.eventAt,
    source: ctx.source,
  };
}

export function runEventFrom(
  run: GhWorkflowRun,
  ctx: {
    installationId: bigint;
    repositoryId: bigint;
    defaultBranch: string | null;
    eventAt: Date;
    source: Source;
  },
): RunEvent {
  return {
    id: BigInt(run.id),
    installationId: ctx.installationId,
    repositoryId: ctx.repositoryId,
    workflowId: big(run.workflow_id),
    workflowName: run.name ?? "",
    workflowPath: run.path ?? null,
    event: run.event ?? null,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha,
    isDefaultBranch:
      ctx.defaultBranch != null && run.head_branch === ctx.defaultBranch,
    actorLogin: run.actor?.login ?? null,
    runNumber: run.run_number ?? null,
    runAttempt: run.run_attempt ?? 1,
    status: mapRunStatus(run.status),
    conclusion: mapConclusion(run.conclusion),
    createdAt: new Date(run.created_at),
    runStartedAt: date(run.run_started_at),
    updatedAt: date(run.updated_at),
    htmlUrl: run.html_url ?? null,
    placeholder: false,
    eventAt: ctx.eventAt,
    source: ctx.source,
  };
}
