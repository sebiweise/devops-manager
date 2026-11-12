import type { PoolDto, RunnerDetail, RunnerDto } from "@/server/data/runners";
import { bucketBounds } from "@/server/metrics/histogram";

/**
 * View logic of the runner and queue pages (design §6.5, §7): runner state,
 * grouping by scope, the weekday × hour heatmap grid, the status strip and
 * the duration bands. Pure functions over the DTOs of `src/server/data/runners`.
 */

export type RunnerState = "busy" | "idle" | "offline";

export function runnerState(
  r: Pick<RunnerDto, "online" | "busy">,
): RunnerState {
  if (!r.online) return "offline";
  return r.busy ? "busy" : "idle";
}

/** Runner detail URL; the cache key contains ":" and is encoded. */
export function runnerHref(accountPath: string, runnerKey: string): string {
  return `${accountPath}/runners/${encodeURIComponent(runnerKey)}`;
}

/** The cache key of a `/runners/[runnerKey]` segment, or null when malformed. */
export function parseRunnerKey(segment: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return /^\d{1,20}:(ORG|REPO):\d{1,20}$/.test(key) ? key : null;
}

export type RunnerGroup = {
  /** null: organisation runners. */
  repoFullName: string | null;
  runners: RunnerDto[];
};

/**
 * Organisation runners first, then repo-level runners grouped by repository
 * (one runner per repository is the expected setup), each sorted by name.
 */
export function groupRunners(runners: ReadonlyArray<RunnerDto>): RunnerGroup[] {
  const org = runners.filter((r) => r.scope === "ORG");
  const byRepo = new Map<string, RunnerDto[]>();
  for (const r of runners) {
    if (r.scope !== "REPO") continue;
    const name = r.repository?.fullName ?? "";
    byRepo.set(name, [...(byRepo.get(name) ?? []), r]);
  }
  const byName = (a: RunnerDto, b: RunnerDto) => a.name.localeCompare(b.name);
  const out: RunnerGroup[] = [];
  if (org.length > 0)
    out.push({ repoFullName: null, runners: [...org].sort(byName) });
  for (const name of [...byRepo.keys()].sort((a, b) => a.localeCompare(b)))
    out.push({ repoFullName: name, runners: byRepo.get(name)!.sort(byName) });
  return out;
}

export function runnerCounts(runners: ReadonlyArray<RunnerDto>) {
  const c = { total: runners.length, busy: 0, idle: 0, offline: 0 };
  for (const r of runners) c[runnerState(r)]++;
  return c;
}

// ---------- heatmap ----------

export type HeatmapGrid = {
  /** 7 rows (Monday .. Sunday) × 24 hours; null where no job was queued. */
  cells: Array<Array<{ jobs: number; queueP95: number | null }>>;
  maxQueueP95: number;
};

export function heatmapGrid(heatmap: PoolDto["heatmap"]): HeatmapGrid {
  const cells = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({
      jobs: 0,
      queueP95: null as number | null,
    })),
  );
  let max = 0;
  for (const h of heatmap) {
    const row = cells[h.weekday - 1];
    if (!row || h.hour < 0 || h.hour > 23) continue;
    row[h.hour] = { jobs: h.jobs, queueP95: h.queueP95 };
    if (h.queueP95 != null) max = Math.max(max, h.queueP95);
  }
  return { cells, maxQueueP95: max };
}

/** Intensity step 0..4 of a value relative to the maximum (0 = empty). */
export function intensity(value: number | null, max: number): number {
  if (value == null || max <= 0) return 0;
  if (value <= 0) return 1;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

// ---------- status strip ----------

export type StripSegment = {
  kind: RunnerState;
  /** Fractions of the window, 0..1. */
  from: number;
  to: number;
};

/**
 * Samples -> contiguous segments of one state over [from, to]. A sample
 * stands for (sampledAt - intervalS, sampledAt]; gaps stay empty (unknown).
 */
export function statusSegments(
  samples: RunnerDetail["statusTimeline"],
  from: number,
  to: number,
): StripSegment[] {
  const span = to - from;
  if (span <= 0) return [];
  const out: StripSegment[] = [];
  for (const s of samples) {
    if (s.intervalS <= 0) continue;
    const end = Date.parse(s.t);
    const start = end - s.intervalS * 1000;
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    if (b <= a) continue;
    const kind: RunnerState = !s.online ? "offline" : s.busy ? "busy" : "idle";
    const seg = { kind, from: (a - from) / span, to: (b - from) / span };
    const last = out[out.length - 1];
    if (last && last.kind === kind && Math.abs(last.to - seg.from) < 1e-9)
      last.to = seg.to;
    else out.push(seg);
  }
  return out;
}

// ---------- duration bands ----------

/** Upper bounds (seconds) of the duration bands of the distribution chart. */
export const DURATION_BANDS = [60, 300, 900, 1800, 3600, Infinity] as const;

/**
 * Collapses an 80-bucket histogram into DURATION_BANDS, as shares of the
 * total (0..1). A bucket counts towards the band its midpoint falls in.
 */
export function bandShares(hist: ReadonlyArray<number>): number[] {
  const counts = DURATION_BANDS.map(() => 0);
  let total = 0;
  hist.forEach((n, i) => {
    if (!n) return;
    const [lo, hi] = bucketBounds(i);
    const mid = Math.sqrt(Math.max(lo, 0.5) * hi);
    const band = DURATION_BANDS.findIndex((b) => mid < b);
    counts[band === -1 ? counts.length - 1 : band]! += n;
    total += n;
  });
  return counts.map((c) => (total > 0 ? c / total : 0));
}
