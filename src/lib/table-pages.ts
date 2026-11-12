import type { Costs } from "@/server/data/costs";
import type { WorkflowStat } from "@/server/data/insights";
import type {
  QueueGroupDto,
  QueueJobDto,
  RunnerDto,
} from "@/server/data/runners";
import { enoughData, MIN_SAMPLES } from "./insights-view";
import { pageRows, type Page } from "./paging";
import type {
  CostRepoFilter,
  CostRepoSortKey,
  CostWorkflowSortKey,
  QueueFilter,
  QueueSortKey,
  RunnerFilter,
  RunnerSortKey,
  WorkflowFilter,
  WorkflowSortKey,
} from "./table-specs";
import type { SortDir } from "./url-state";

/**
 * Search, filter, sort and paging of the lists the data layer computes in
 * full (UI overhaul §4.1): workflows, runners, the queue and the cost
 * breakdowns. Pure functions over the DTOs, so the rules are unit-tested;
 * the data modules expose them as paged reads.
 */

export type ListQuery<S extends string, F extends string> = {
  q?: string;
  sort: S;
  dir: SortDir;
  page: number;
  size: number;
  filters?: readonly F[];
};

// ---------- workflows ----------

/** Below 80 % success with enough runs to mean something. */
export function isLowSuccess(w: WorkflowStat): boolean {
  const s = w.summary;
  return (
    s.successRate != null &&
    s.success + s.failure >= MIN_SAMPLES &&
    s.successRate < 0.8
  );
}

export function pageWorkflows(
  rows: ReadonlyArray<WorkflowStat>,
  query: ListQuery<WorkflowSortKey, WorkflowFilter> & { repositoryId?: string },
): Page<WorkflowStat> {
  const f = new Set(query.filters ?? []);
  return pageRows(rows, query, {
    text: (w) => `${w.workflowName} ${w.repoFullName}`,
    filter: (w) =>
      (!query.repositoryId || w.repositoryId === query.repositoryId) &&
      (!f.has("regressed") || !!w.regression || !!w.successDrop) &&
      (!f.has("flaky") || (w.summary.flakyRate ?? 0) > 0) &&
      (!f.has("lowSuccess") || isLowSuccess(w)),
    keys: {
      name: (w) => w.workflowName.toLowerCase(),
      runs: (w) => w.summary.runs,
      success: (w) => w.summary.successRate,
      flaky: (w) => w.summary.flakyRate,
      // Percentiles of too few runs sort last, like the "few runs" cell.
      p50: (w) => (enoughData(w.summary.n) ? w.summary.p50 : null),
      p95: (w) => (enoughData(w.summary.n) ? w.summary.p95 : null),
      minutes: (w) => w.billableMinEst,
    },
    tiebreak: (a, b) =>
      a.repoFullName.localeCompare(b.repoFullName) ||
      a.workflowName.localeCompare(b.workflowName),
  });
}

// ---------- runners ----------

export function runnerState(r: RunnerDto): "busy" | "idle" | "offline" {
  if (!r.online) return "offline";
  return r.busy ? "busy" : "idle";
}

const STATE_ORDER = { busy: 0, idle: 1, offline: 2 } as const;

export function pageRunners(
  rows: ReadonlyArray<RunnerDto>,
  query: ListQuery<RunnerSortKey, RunnerFilter> & { repositoryId?: string },
): Page<RunnerDto> {
  const f = new Set(query.filters ?? []);
  return pageRows(rows, query, {
    text: (r) => [r.name, r.repository?.fullName ?? "", ...r.labels].join(" "),
    filter: (r) =>
      (f.size === 0 || f.has(runnerState(r))) &&
      (!query.repositoryId || r.repository?.id === query.repositoryId),
    keys: {
      name: (r) => r.name.toLowerCase(),
      state: (r) => STATE_ORDER[runnerState(r)],
      jobs: (r) => r.jobs7d,
      utilisation: (r) => r.utilisation7d.value,
      lastSeen: (r) => r.lastSeenAt,
    },
    tiebreak: (a, b) =>
      a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
  });
}

// ---------- queue ----------

export function pageQueueGroups(
  rows: ReadonlyArray<QueueGroupDto>,
  query: ListQuery<QueueSortKey, QueueFilter> & { repositoryId?: string },
): Page<QueueGroupDto> {
  const f = new Set(query.filters ?? []);
  return pageRows(rows, query, {
    text: (g) => [g.labels.join(","), g.repoFullName, ...g.workflows].join(" "),
    filter: (g) =>
      (!f.has("stuck") || g.stuck > 0) &&
      (!f.has("noRunner") || g.noMatchingRunner) &&
      (!query.repositoryId || g.repositoryId === query.repositoryId),
    keys: {
      age: (g) => g.oldestAgeS,
      count: (g) => g.count,
      name: (g) => g.labelKey,
    },
    tiebreak: (a, b) =>
      a.labelKey.localeCompare(b.labelKey) ||
      a.repoFullName.localeCompare(b.repoFullName),
  });
}

export function pageQueueJobs(
  rows: ReadonlyArray<QueueJobDto>,
  query: ListQuery<QueueSortKey, QueueFilter> & { repositoryId?: string },
): Page<QueueJobDto> {
  const f = new Set(query.filters ?? []);
  return pageRows(rows, query, {
    text: (j) => `${j.name} ${j.workflowName} ${j.repoFullName}`,
    filter: (j) =>
      (!f.has("stuck") || j.stuck) &&
      (!f.has("noRunner") || j.noMatchingRunner) &&
      (!query.repositoryId || j.repositoryId === query.repositoryId),
    keys: {
      age: (j) => j.ageS,
      count: () => 1,
      name: (j) => j.name.toLowerCase(),
    },
    tiebreak: (a, b) => a.jobId.localeCompare(b.jobId),
  });
}

// ---------- costs ----------

export type CostRepoRow = Costs["byRepo"][number] & {
  /** Billed gross USD of the minutes (estimate check), null when not billed. */
  billedGrossUsd: number | null;
  /** (estimate - billed) / billed on gross USD, from the reconciliation. */
  deviation: number | null;
  flagged: boolean;
};

/** By repository with the estimate check merged in (§2.12). */
export function costRepoRows(costs: Costs): CostRepoRow[] {
  const recon = new Map<
    string,
    { billed: number; est: number; flagged: boolean }
  >();
  for (const r of costs.reconciliation) {
    const cur = recon.get(r.repositoryFullName) ?? {
      billed: 0,
      est: 0,
      flagged: false,
    };
    cur.billed += r.billedGrossUsd;
    cur.est += r.estUsd;
    cur.flagged ||= r.flagged;
    recon.set(r.repositoryFullName, cur);
  }
  return costs.byRepo.map((r) => {
    const c = recon.get(r.repositoryFullName);
    return {
      ...r,
      billedGrossUsd: c ? c.billed : null,
      deviation: c && c.billed > 0 ? (c.est - c.billed) / c.billed : null,
      flagged: c?.flagged ?? false,
    };
  });
}

export function pageCostRepos(
  rows: ReadonlyArray<CostRepoRow>,
  query: ListQuery<CostRepoSortKey, CostRepoFilter>,
): Page<CostRepoRow> {
  const f = new Set(query.filters ?? []);
  return pageRows(rows, query, {
    text: (r) => r.repositoryFullName,
    filter: (r) => !f.has("flagged") || r.flagged,
    keys: {
      name: (r) => r.repositoryFullName.toLowerCase(),
      net: (r) => r.netUsd,
      gross: (r) => r.grossUsd,
      minutes: (r) => r.billedQuantity || r.estMin,
      estimate: (r) => r.estUsd,
      deviation: (r) => (r.deviation == null ? null : Math.abs(r.deviation)),
    },
  });
}

export function pageCostWorkflows(
  rows: ReadonlyArray<Costs["byWorkflow"][number]>,
  query: ListQuery<CostWorkflowSortKey, never>,
): Page<Costs["byWorkflow"][number]> {
  return pageRows(rows, query, {
    text: (w) => `${w.workflowName} ${w.repositoryFullName}`,
    keys: {
      name: (w) => w.workflowName.toLowerCase(),
      minutes: (w) => w.estMin,
      estimate: (w) => w.estUsd,
      net: (w) => w.scaledNetUsd,
    },
    tiebreak: (a, b) =>
      a.repositoryFullName.localeCompare(b.repositoryFullName) ||
      a.workflowName.localeCompare(b.workflowName) ||
      a.sku.localeCompare(b.sku),
  });
}
