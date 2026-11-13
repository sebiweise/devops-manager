import {
  histogramCount,
  histogramPercentile,
  mergeHistograms,
} from "@/server/metrics/histogram";
import {
  firstTrySuccessRate,
  flakyRate,
  successRate,
} from "@/server/metrics/stats";

/**
 * Pure view helpers of the Azure Pipelines pages (design addendum M7 §6,
 * §7): status badges (partially succeeded is amber, never a success), the
 * operations a build offers, result texts of the settings and M7b actions,
 * and the pipeline summary over DailyPipelineStat rows (the same stats.ts
 * and histogram.ts as the GitHub summaries; a parity test pins it).
 * Client-safe.
 */

export type AzureBadgeKind =
  | "SUCCESS"
  | "FAILURE"
  | "CANCELLED"
  | "TIMED_OUT"
  | "QUEUED"
  | "IN_PROGRESS"
  | "WAITING"
  | "partial"
  | "deployUnknown";

/** The shared status badge of a build (or job) status and result. */
export function azureBadgeKind(
  status: string,
  result: string | null,
  timedOut = false,
): AzureBadgeKind {
  if (status === "COMPLETED" || status === "completed") {
    if (timedOut) return "TIMED_OUT";
    switch (result) {
      case "SUCCEEDED":
      case "SUCCEEDED_WITH_ISSUES":
        return result === "SUCCEEDED_WITH_ISSUES" ? "partial" : "SUCCESS";
      case "PARTIALLY_SUCCEEDED":
        return "partial";
      case "FAILED":
      case "ABANDONED":
        return "FAILURE";
      case "CANCELED":
        return "CANCELLED";
      case "SKIPPED":
        return "CANCELLED";
      default:
        return "deployUnknown";
    }
  }
  switch (status) {
    case "NOT_STARTED":
    case "pending":
      return "QUEUED";
    case "POSTPONED":
      return "WAITING";
    case "IN_PROGRESS":
    case "inProgress":
    case "CANCELLING":
      return "IN_PROGRESS";
    default:
      return "deployUnknown";
  }
}

/** The union layer's status and conclusion (GitHub's vocabulary) of an Azure build. */
export function azureAsRunStatus(
  status: string,
  result: string | null,
  timedOut = false,
): { status: string; conclusion: string | null } {
  if (status === "COMPLETED") {
    if (timedOut) return { status: "COMPLETED", conclusion: "TIMED_OUT" };
    const c =
      result === "SUCCEEDED"
        ? "SUCCESS"
        : result === "PARTIALLY_SUCCEEDED"
          ? "PARTIAL"
          : result === "FAILED"
            ? "FAILURE"
            : result === "CANCELED"
              ? "CANCELLED"
              : null;
    return { status: "COMPLETED", conclusion: c };
  }
  if (status === "NOT_STARTED") return { status: "QUEUED", conclusion: null };
  if (status === "POSTPONED") return { status: "WAITING", conclusion: null };
  return { status: "IN_PROGRESS", conclusion: null };
}

export type AzureOperation = "cancel" | "retry" | "retryStage";

/** What a build offers (the server checks every rule again on submit). */
export function azureOperations(b: {
  status: string;
  result: string | null;
}): AzureOperation[] {
  const ops: AzureOperation[] = [];
  if (
    b.status === "NOT_STARTED" ||
    b.status === "POSTPONED" ||
    b.status === "IN_PROGRESS"
  )
    ops.push("cancel");
  if (
    b.status === "COMPLETED" &&
    (b.result === "FAILED" ||
      b.result === "PARTIALLY_SUCCEEDED" ||
      b.result === "CANCELED")
  )
    ops.push("retry");
  return ops;
}

/** A stage offers a retry when it failed or was canceled and the build finished. */
export function stageRetryable(
  build: { status: string },
  stage: { state: string; result: string },
): boolean {
  return (
    build.status === "COMPLETED" &&
    stage.state === "completed" &&
    (stage.result === "FAILED" || stage.result === "CANCELED")
  );
}

export type DailyPipelineRow = {
  builds: number;
  succeeded: number;
  partial: number;
  failed: number;
  canceled: number;
  timedOut: number;
  firstTrySuccess: number;
  flakyRecovered: number;
  durationHist: ReadonlyArray<number> | null;
  queueHist: ReadonlyArray<number> | null;
  jobSecondsHostedLinux?: number;
  jobSecondsHostedWindows?: number;
  jobSecondsHostedMacos?: number;
  jobSecondsSelfHosted?: number;
  jobsNearCap?: number;
};

export type PipelineSummary = {
  builds: number;
  succeeded: number;
  partial: number;
  failed: number;
  canceled: number;
  timedOut: number;
  /** succeeded / (succeeded + failed + partial + timedOut) */
  successRate: number | null;
  firstTrySuccessRate: number | null;
  flakyRate: number | null;
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  queueP95: number | null;
  hostedMinutes: number;
  macosMinutes: number;
  /** macOS share of the hosted minutes. */
  macosShare: number | null;
  jobsNearCap: number;
};

export function pipelineSummary(
  rows: ReadonlyArray<DailyPipelineRow>,
): PipelineSummary {
  const sum = (k: keyof DailyPipelineRow) =>
    rows.reduce((acc, r) => acc + Number((r[k] as number | undefined) ?? 0), 0);
  const dur = mergeHistograms(...rows.map((r) => r.durationHist));
  const queue = mergeHistograms(...rows.map((r) => r.queueHist));
  const succeeded = sum("succeeded");
  const failure = sum("failed") + sum("partial") + sum("timedOut");
  const counts = {
    success: succeeded,
    failure,
    firstTrySuccess: sum("firstTrySuccess"),
    flakyRecovered: sum("flakyRecovered"),
  };
  const hostedS =
    sum("jobSecondsHostedLinux") +
    sum("jobSecondsHostedWindows") +
    sum("jobSecondsHostedMacos");
  const macS = sum("jobSecondsHostedMacos");
  return {
    builds: sum("builds"),
    succeeded,
    partial: sum("partial"),
    failed: sum("failed"),
    canceled: sum("canceled"),
    timedOut: sum("timedOut"),
    successRate: successRate(counts),
    firstTrySuccessRate: firstTrySuccessRate(counts),
    flakyRate: flakyRate(counts),
    n: histogramCount(dur),
    p50: histogramPercentile(dur, 0.5),
    p90: histogramPercentile(dur, 0.9),
    p95: histogramPercentile(dur, 0.95),
    queueP95: histogramPercentile(queue, 0.95),
    hostedMinutes: Math.round(hostedS / 60),
    macosMinutes: Math.round(macS / 60),
    macosShare: hostedS > 0 ? macS / hostedS : null,
    jobsNearCap: sum("jobsNearCap"),
  };
}

/** Error and refusal codes of the Azure settings actions (messages: ci.azure.settings.errors). */
export const AZURE_ERROR_CODES = [
  "invalid_org",
  "org_not_allowed",
  "invalid_token",
  "invalid_secret",
  "entra_unavailable",
  "scope_missing_projects",
  "scope_missing_pools",
  "scope_missing_build",
  "rate_limited",
  "azure_unavailable",
  "invalid_input",
  "org_changed",
  "already_connected",
  "already_connected_elsewhere",
  "not_connected",
  "env_managed",
  "invalid_repository",
  "invalid_definition",
  "unchanged",
  "scope_missing_hooks",
  "public_url_required",
  "execute_probe_failed",
  "no_linked_definition",
] as const;

/** Refusal reasons of the M7b actions (messages: ci.azure.actions.refused). */
export const AZURE_ACTION_REFUSALS = [
  "not_cancelable",
  "not_retryable",
  "stage_not_retryable",
  "definition_unlinked",
  "branch_unknown",
  "quota_exhausted",
  "invalid_stage",
] as const;

/** Reasons of an `unavailable` result of an Azure action. */
export const AZURE_UNAVAILABLE = [
  "management_disabled_global",
  "management_disabled_installation",
  "azure_management_disabled_global",
  "azure_not_connected",
  "azure_revoked",
  "azure_rate_limited",
  "azure_management_disabled",
  "azure_scope_missing",
] as const;

export type AzureResultLike = {
  status: string;
  replayed?: boolean;
  message?: string;
  reason?: string;
  level?: "global" | "installation";
  retryAfterS?: number;
};

type Text = {
  key: string;
  values: Record<string, string | number>;
  tone: "success" | "error" | "info";
};

/** The message of an Azure settings or action result, as a full message key. */
export function azureResultText(r: AzureResultLike): Text {
  switch (r.status) {
    case "succeeded":
      return {
        key: r.replayed
          ? "management.result.replayed"
          : "ci.azure.result.succeeded",
        values: {},
        tone: "success",
      };
    case "pending":
      return { key: "management.result.pending", values: {}, tone: "info" };
    case "failed": {
      const code = (r.message ?? "").split(":")[0] ?? "";
      if (code === "outcome_unknown")
        return {
          key: "ci.azure.result.outcomeUnknown",
          values: {},
          tone: "info",
        };
      if ((AZURE_ERROR_CODES as readonly string[]).includes(r.message ?? ""))
        return {
          key: `ci.azure.settings.errors.${r.message}`,
          values: {},
          tone: "error",
        };
      return {
        key: "ci.azure.result.failed",
        values: { message: r.message || "—" },
        tone: "error",
      };
    }
    case "refused":
      if ((AZURE_ACTION_REFUSALS as readonly string[]).includes(r.reason ?? ""))
        return {
          key: `ci.azure.actions.refused.${r.reason}`,
          values: {},
          tone: "error",
        };
      if ((AZURE_ERROR_CODES as readonly string[]).includes(r.reason ?? ""))
        return {
          key: `ci.azure.settings.errors.${r.reason}`,
          values: {},
          tone: "error",
        };
      return {
        key: "ci.azure.settings.errors.other",
        values: { code: r.reason || "—" },
        tone: "error",
      };
    case "unavailable":
      return (AZURE_UNAVAILABLE as readonly string[]).includes(r.reason ?? "")
        ? {
            key: `ci.azure.actions.unavailable.${r.reason}`,
            values: {},
            tone: "error",
          }
        : { key: "management.result.error", values: {}, tone: "error" };
    case "management_disabled":
      return {
        key:
          r.level === "global"
            ? "management.result.management_disabled_global"
            : "management.result.management_disabled_installation",
        values: {},
        tone: "error",
      };
    case "rate_limited":
      return {
        key: "management.result.rate_limited",
        values: { seconds: r.retryAfterS ?? 60 },
        tone: "error",
      };
    case "unauthorized":
    case "forbidden":
    case "confirmation_mismatch":
    case "conflict":
      return {
        key: `management.result.${r.status}`,
        values: {},
        tone: "error",
      };
    default:
      return { key: "management.result.error", values: {}, tone: "error" };
  }
}

/** Short build label "#20261113.4" or the id. */
export function buildLabel(b: {
  buildNumber: string | null;
  id: number | string;
}): string {
  return b.buildNumber ? `#${b.buildNumber}` : `#${b.id}`;
}

export type CiProvider = "github" | "azure";
export const CI_FACETS = ["all", "github", "azure"] as const;
export type CiFacet = (typeof CI_FACETS)[number];

export function parseCiFacet(v: string | undefined | null): CiFacet {
  return v === "github" || v === "azure" ? v : "all";
}
