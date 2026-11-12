import type { TableSpec } from "./url-state";

/**
 * Sort keys, default order and filter chips of every paged table (UI
 * overhaul §2, §4.1), shared by the pages (URL parsing, sortable headers)
 * and the data layer (allow-listed ORDER BY). An unknown key in the URL
 * falls back to the table's default.
 */

// ---------- repositories ----------

export const REPO_SORTS = [
  "name",
  "lastRun",
  "runs",
  "success",
  "p50",
  "minutes",
  "prs",
  "alerts",
] as const;
export type RepoSortKey = (typeof REPO_SORTS)[number];

export const REPO_FILTERS = [
  "failing",
  "forks",
  "private",
  "archived",
  "ignored",
] as const;
export type RepoFilter = (typeof REPO_FILTERS)[number];

export const REPO_TABLE: TableSpec<RepoSortKey, RepoFilter> = {
  sorts: REPO_SORTS,
  defaultSort: "lastRun",
  defaultDir: { name: "asc" },
  filters: REPO_FILTERS,
};

// ---------- workflows ----------

export const WORKFLOW_SORTS = [
  "name",
  "runs",
  "success",
  "flaky",
  "p50",
  "p95",
  "minutes",
] as const;
export type WorkflowSortKey = (typeof WORKFLOW_SORTS)[number];

export const WORKFLOW_FILTERS = ["regressed", "flaky", "lowSuccess"] as const;
export type WorkflowFilter = (typeof WORKFLOW_FILTERS)[number];

export const WORKFLOW_TABLE: TableSpec<WorkflowSortKey, WorkflowFilter> = {
  sorts: WORKFLOW_SORTS,
  defaultSort: "runs",
  defaultDir: { name: "asc", success: "asc" },
  filters: WORKFLOW_FILTERS,
};

/** Quick views: a preset of sort and filter (§2.5); they only set the URL. */
export const WORKFLOW_QUICK_VIEWS = {
  slowest: { sort: "p95", dir: "desc", filters: [] },
  flakiest: { sort: "flaky", dir: "desc", filters: ["flaky"] },
  mostMinutes: { sort: "minutes", dir: "desc", filters: [] },
  lowestSuccess: { sort: "success", dir: "asc", filters: ["lowSuccess"] },
  regressions: { sort: "p95", dir: "desc", filters: ["regressed"] },
} as const satisfies Record<
  string,
  {
    sort: WorkflowSortKey;
    dir: "asc" | "desc";
    filters: readonly WorkflowFilter[];
  }
>;
export type WorkflowQuickView = keyof typeof WORKFLOW_QUICK_VIEWS;

// ---------- runners ----------

export const RUNNER_SORTS = [
  "name",
  "state",
  "jobs",
  "utilisation",
  "lastSeen",
] as const;
export type RunnerSortKey = (typeof RUNNER_SORTS)[number];

export const RUNNER_FILTERS = ["busy", "idle", "offline"] as const;
export type RunnerFilter = (typeof RUNNER_FILTERS)[number];

export const RUNNER_TABLE: TableSpec<RunnerSortKey, RunnerFilter> = {
  sorts: RUNNER_SORTS,
  defaultSort: "name",
  defaultDir: { name: "asc", state: "asc" },
  filters: RUNNER_FILTERS,
};

// ---------- queue ----------

export const QUEUE_SORTS = ["age", "count", "name"] as const;
export type QueueSortKey = (typeof QUEUE_SORTS)[number];

export const QUEUE_FILTERS = ["stuck", "noRunner"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export const QUEUE_TABLE: TableSpec<QueueSortKey, QueueFilter> = {
  sorts: QUEUE_SORTS,
  defaultSort: "age",
  defaultDir: { name: "asc" },
  filters: QUEUE_FILTERS,
};

// ---------- costs ----------

export const COST_REPO_SORTS = [
  "name",
  "net",
  "gross",
  "minutes",
  "estimate",
  "deviation",
] as const;
export type CostRepoSortKey = (typeof COST_REPO_SORTS)[number];

export const COST_REPO_FILTERS = ["flagged"] as const;
export type CostRepoFilter = (typeof COST_REPO_FILTERS)[number];

export const COST_REPO_TABLE: TableSpec<CostRepoSortKey, CostRepoFilter> = {
  sorts: COST_REPO_SORTS,
  defaultSort: "net",
  defaultDir: { name: "asc" },
  filters: COST_REPO_FILTERS,
};

export const COST_WORKFLOW_SORTS = [
  "name",
  "minutes",
  "estimate",
  "net",
] as const;
export type CostWorkflowSortKey = (typeof COST_WORKFLOW_SORTS)[number];

export const COST_WORKFLOW_TABLE: TableSpec<CostWorkflowSortKey, never> = {
  sorts: COST_WORKFLOW_SORTS,
  defaultSort: "minutes",
  defaultDir: { name: "asc" },
};
