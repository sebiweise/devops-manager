/**
 * View logic of the management UI (design §7, §8.2): which run operations a
 * run offers, how an action result is put into words, and when a merge is
 * blocked. Pure functions; the server enforces every rule again.
 */

export type RunOperation = "rerun" | "rerun_failed" | "cancel" | "force_cancel";

/** GitHub's limit of attempts per run (design §8.2 #1). */
export const MAX_RUN_ATTEMPT = 50;

const RERUN_FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
]);

/**
 * The operations a run offers: a completed run can be re-run (below the
 * attempt limit) and, when it did not succeed, re-run for its failed jobs;
 * a run in progress can be cancelled, and force cancelled once a cancel is
 * older than 60 s (`forceCancelAvailable`, computed by the page).
 */
export function runOperationsFor(
  run: {
    status: string;
    conclusion: string | null;
    runAttempt: number;
    isPlaceholder?: boolean;
  },
  forceCancelAvailable = false,
): RunOperation[] {
  if (run.isPlaceholder) return [];
  if (run.status === "COMPLETED") {
    const ops: RunOperation[] = [];
    if (run.runAttempt < MAX_RUN_ATTEMPT) ops.push("rerun");
    if (run.conclusion && RERUN_FAILED_CONCLUSIONS.has(run.conclusion))
      ops.push("rerun_failed");
    return ops;
  }
  return forceCancelAvailable ? ["cancel", "force_cancel"] : ["cancel"];
}

/** Any result a management Server Action can answer with. */
export type ResultLike =
  | {
      status: string;
      replayed?: boolean;
      message?: string;
      level?: "global" | "installation";
      missing?: string[];
      retryAfterS?: number;
      reason?: string;
      detail?: Record<string, string | number | boolean | null>;
    }
  /** The Server Action threw (network error, 404 page, server error). */
  | { status: "error" };

export type ResultText = {
  /** A key below the `management` namespace. */
  key: string;
  values: Record<string, string | number>;
  tone: "success" | "error" | "info";
};

const KNOWN_REFUSALS = new Set([
  "attempt_limit",
  "cancel_first",
  "force_cancel_too_early",
  "invalid_name",
  "invalid_value",
  "archived",
  "not_selected",
  "unreadable",
  "drifted",
  "stale_preview",
  "unchanged",
  "variable_not_found",
  "too_many_repositories",
  "no_writable_repositories",
  "not_revertible",
  "values_unavailable",
  "already_reverted",
  "nothing_to_revert",
  "not_organization",
  "pr_not_found",
  "already_merged",
  "not_open",
  "draft",
  "not_mergeable",
  "mergeability_unknown",
  "needs_acknowledgement",
  "branch_protection",
]);

/** The message key, its values and the tone of an action result. */
export function resultText(result: ResultLike): ResultText {
  const r = result as Extract<ResultLike, { replayed?: boolean }>;
  switch (r.status) {
    case "succeeded":
      return {
        key: r.replayed ? "result.replayed" : "result.succeeded",
        values: {},
        tone: "success",
      };
    case "failed":
      return {
        key: "result.failed",
        values: { message: r.message || "—" },
        tone: "error",
      };
    case "pending":
      return { key: "result.pending", values: {}, tone: "info" };
    case "management_disabled":
      return {
        key:
          r.level === "global"
            ? "result.management_disabled_global"
            : "result.management_disabled_installation",
        values: {},
        tone: "error",
      };
    case "permission_not_granted":
      return {
        key: "result.permission_not_granted",
        values: { permissions: (r.missing ?? []).join(", ") || "—" },
        tone: "error",
      };
    case "rate_limited":
      return {
        key: "result.rate_limited",
        values: { seconds: r.retryAfterS ?? 60 },
        tone: "error",
      };
    case "unauthorized":
    case "forbidden":
    case "confirmation_mismatch":
    case "conflict":
      return { key: `result.${r.status}`, values: {}, tone: "error" };
    case "refused": {
      const reason = r.reason ?? "";
      if (!KNOWN_REFUSALS.has(reason))
        return {
          key: "result.refusedOther",
          values: { reason: reason || "—" },
          tone: "error",
        };
      const d = r.detail ?? {};
      return {
        key: `refused.${reason}`,
        values: {
          seconds: Number(d.retryAfterS ?? 60),
          state: String(d.mergeableState ?? "unknown"),
        },
        tone: "error",
      };
    }
    default:
      return { key: "result.error", values: {}, tone: "error" };
  }
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** Squash is preselected when the repo allows it, then merge, then rebase. */
export function defaultMergeMethod(
  allowed: readonly MergeMethod[],
): MergeMethod | null {
  for (const m of ["squash", "merge", "rebase"] as const)
    if (allowed.includes(m)) return m;
  return null;
}

export type MergeBlock =
  | "draft"
  | "conflicting"
  | "unknown"
  | "branch_protection"
  | "workflows_not_granted"
  | "no_method";

/**
 * Why a PR's merge button is disabled, or null when the merge dialog may
 * open. A PR whose changed files are unknown (more than 100) counts as
 * changing workflows only for the explainer; the server decides from the
 * full file list.
 */
export function mergeBlock(
  pull: {
    isDraft: boolean;
    mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    mergeStateStatus?: string | null;
    changesWorkflows: boolean | null;
  },
  options: { workflowsGranted: boolean; methods: readonly MergeMethod[] },
): MergeBlock | null {
  const state = (pull.mergeStateStatus ?? "").toUpperCase();
  if (pull.isDraft) return "draft";
  if (pull.mergeable === "CONFLICTING" || state === "DIRTY")
    return "conflicting";
  if (pull.mergeable === "UNKNOWN") return "unknown";
  // Branch protection is never overridden from here (the server refuses it).
  if (state === "BLOCKED") return "branch_protection";
  if (pull.changesWorkflows === true && !options.workflowsGranted)
    return "workflows_not_granted";
  if (options.methods.length === 0) return "no_method";
  return null;
}

/** GitHub's merge state needs the extra warning checkbox unless it is CLEAN. */
export function needsAcknowledgement(mergeStateStatus: string | null): boolean {
  return (mergeStateStatus ?? "UNKNOWN").toUpperCase() !== "CLEAN";
}

/** The checks rollup as a label key (`management.checks.*`). */
export function checksKey(checks: string | null): string {
  switch (checks) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}
