import type {
  Freshness,
  JobBreakdown,
  RepoStat,
  WorkflowStat,
} from "@/server/data/insights";

/**
 * View logic of the insights pages: sorting, leaderboards, the hosted vs
 * self-hosted comparison and the stale-banner reasons. Pure functions over
 * the DTOs of `src/server/data/insights`.
 */

/** Below this sample size percentiles show "not enough data" (design §7). */
export const MIN_SAMPLES = 10;

export function enoughData(n: number | null | undefined): boolean {
  return (n ?? 0) >= MIN_SAMPLES;
}

// ---------- search params ----------

export type SearchParams = Record<string, string | string[] | undefined>;

export function param(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

/** `base?…` with `changes` applied; undefined removes a key. */
export function withParams(
  base: string,
  current: SearchParams,
  changes: Record<string, string | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s !== undefined && s !== "") q.set(k, s);
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

// ---------- run list cursor ----------
/** Keyset cursor <-> `?before=` value. */
export function encodeCursor(c: { createdAt: string; id: string }): string {
  return `${c.createdAt}_${c.id}`;
}

export function decodeCursor(
  value: string | undefined,
): { createdAt: string; id: string } | undefined {
  if (!value) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(\d{1,20})$/.exec(value);
  if (!m || Number.isNaN(Date.parse(m[1]!))) return undefined;
  return { createdAt: m[1]!, id: m[2]! };
}

const CONCLUSIONS = [
  "SUCCESS",
  "FAILURE",
  "CANCELLED",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "NEUTRAL",
  "STALE",
  "STARTUP_FAILURE",
] as const;

export type ConclusionFilter = (typeof CONCLUSIONS)[number];

export const CONCLUSION_FILTERS: ReadonlyArray<ConclusionFilter> = CONCLUSIONS;

export function parseConclusion(
  value: string | undefined,
): ConclusionFilter | undefined {
  const v = value?.toUpperCase();
  return (CONCLUSIONS as readonly string[]).includes(v ?? "")
    ? (v as ConclusionFilter)
    : undefined;
}

/** Free-text filters are trimmed and capped so they stay cheap to query. */
export function textFilter(value: string | undefined): string | undefined {
  const v = value?.trim().slice(0, 200);
  return v ? v : undefined;
}

// ---------- freshness ----------

export type StaleReason = "noWebhook" | "noReconcile" | "failedDeliveries";

const HOUR = 3_600_000;

/** Why the stale banner shows (design §7 "data-freshness pill"). */
export function staleReasons(f: Freshness, now: Date): StaleReason[] {
  const t = now.getTime();
  const out: StaleReason[] = [];
  if (
    f.hasRuns &&
    (!f.lastWebhookAt || t - Date.parse(f.lastWebhookAt) > 6 * HOUR)
  )
    out.push("noWebhook");
  if (!f.lastReconciledAt || t - Date.parse(f.lastReconciledAt) > 24 * HOUR)
    out.push("noReconcile");
  if (f.failedDeliveries + f.deadDeliveries > 0) out.push("failedDeliveries");
  return out;
}

// ---------- repositories ----------

export const REPO_SORTS = [
  "name",
  "lastRun",
  "runs",
  "success",
  "p50",
  "minutes",
] as const;
export type RepoSort = (typeof REPO_SORTS)[number];

export function parseRepoSort(value: string | undefined): RepoSort {
  return (REPO_SORTS as readonly string[]).includes(value ?? "")
    ? (value as RepoSort)
    : "name";
}

/** Nulls always sort last, whatever the direction. */
function compareNullable(
  a: number | string | null,
  b: number | string | null,
  dir: 1 | -1,
): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" && typeof b === "string")
    return a.localeCompare(b) * dir;
  return (a < b ? -1 : 1) * dir;
}

export function sortRepoStats(
  rows: ReadonlyArray<RepoStat>,
  sort: RepoSort,
  dir: "asc" | "desc",
  query?: string,
): RepoStat[] {
  const q = query?.trim().toLowerCase();
  const d = dir === "asc" ? 1 : -1;
  const key = (r: RepoStat): number | string | null => {
    switch (sort) {
      case "name":
        return r.fullName.toLowerCase();
      case "lastRun":
        return r.lastRun?.createdAt ?? null;
      case "runs":
        return r.runs7d;
      case "success":
        return r.successRate7d;
      case "p50":
        return r.p50Duration7d;
      case "minutes":
        return r.billableMinEst30d;
    }
  };
  return rows
    .filter((r) => !q || r.fullName.toLowerCase().includes(q))
    .slice()
    .sort(
      (a, b) =>
        compareNullable(key(a), key(b), d) ||
        a.fullName.localeCompare(b.fullName),
    );
}

// ---------- workflow leaderboards ----------

export type Leaderboards = {
  slowest: WorkflowStat[];
  flakiest: WorkflowStat[];
  mostMinutes: WorkflowStat[];
  lowestSuccess: WorkflowStat[];
  regressions: WorkflowStat[];
};

export function leaderboards(
  stats: ReadonlyArray<WorkflowStat>,
  limit = 10,
): Leaderboards {
  const top = (
    rows: WorkflowStat[],
    by: (w: WorkflowStat) => number,
    dir: 1 | -1 = -1,
  ) =>
    rows
      .slice()
      .sort(
        (a, b) =>
          (by(a) - by(b)) * dir ||
          a.repoFullName.localeCompare(b.repoFullName) ||
          a.workflowName.localeCompare(b.workflowName),
      )
      .slice(0, limit);
  const all = [...stats];
  return {
    slowest: top(
      all.filter((w) => w.summary.p95 != null && enoughData(w.summary.n)),
      (w) => w.summary.p95!,
    ),
    flakiest: top(
      all.filter((w) => (w.summary.flakyRate ?? 0) > 0),
      (w) => w.summary.flakyRate!,
    ),
    mostMinutes: top(
      all.filter((w) => w.billableMinEst > 0),
      (w) => w.billableMinEst,
    ),
    lowestSuccess: top(
      all.filter(
        (w) =>
          w.summary.successRate != null &&
          w.summary.success + w.summary.failure >= MIN_SAMPLES,
      ),
      (w) => w.summary.successRate!,
      1,
    ),
    regressions: top(
      all.filter((w) => w.regression),
      (w) => w.regression!.ratio,
    ),
  };
}

// ---------- hosted vs self-hosted ----------

export type KindComparison = {
  baseName: string;
  hosted: JobBreakdown;
  selfHosted: JobBreakdown;
  /** (self-hosted p50 - hosted p50) / hosted p50; negative is faster. */
  deltaP50: number | null;
};

const HOSTED = new Set(["GITHUB_HOSTED", "LARGER_HOSTED"]);
const MIN_COMPARE = 5;

/**
 * Jobs that ran on both hosted and self-hosted runners with n >= 5 on each
 * side (design §6.5). When a job ran on several pools of one kind, the pool
 * with the most jobs represents that kind.
 */
export function hostedVsSelfHosted(
  jobs: ReadonlyArray<JobBreakdown>,
): KindComparison[] {
  const by = new Map<
    string,
    { hosted?: JobBreakdown; selfHosted?: JobBreakdown }
  >();
  for (const j of jobs) {
    if (j.jobs < MIN_COMPARE) continue;
    const side = HOSTED.has(j.runnerKind)
      ? "hosted"
      : j.runnerKind === "SELF_HOSTED"
        ? "selfHosted"
        : null;
    if (!side) continue;
    const entry = by.get(j.baseName) ?? {};
    const cur = entry[side];
    if (!cur || j.jobs > cur.jobs) entry[side] = j;
    by.set(j.baseName, entry);
  }
  const out: KindComparison[] = [];
  for (const [baseName, e] of by) {
    if (!e.hosted || !e.selfHosted) continue;
    const h = e.hosted.p50;
    const s = e.selfHosted.p50;
    out.push({
      baseName,
      hosted: e.hosted,
      selfHosted: e.selfHosted,
      deltaP50: h != null && s != null && h > 0 ? (s - h) / h : null,
    });
  }
  return out.sort((a, b) => a.baseName.localeCompare(b.baseName));
}
