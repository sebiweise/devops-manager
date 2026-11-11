/**
 * Scales and layouts for the SVG/HTML charts. Pure, so chart geometry is
 * unit-tested without a browser.
 */

/** Rounds up to 1, 2, 2.5 or 5 x 10^n; at least 1. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base + 1e-9) return step * base;
  }
  return 10 * base;
}

/** Evenly spaced ticks from 0 to max, inclusive. */
export function ticks(max: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push((max / count) * i);
  return out;
}

export type StackSegment = { key: string; y0: number; y1: number };

/** Cumulative stack of `keys` for one data point (bottom to top). */
export function stack(
  values: Record<string, number>,
  keys: ReadonlyArray<string>,
): StackSegment[] {
  let y = 0;
  const out: StackSegment[] = [];
  for (const key of keys) {
    const v = Math.max(0, values[key] ?? 0);
    if (v === 0) continue;
    out.push({ key, y0: y, y1: y + v });
    y += v;
  }
  return out;
}

/**
 * SVG path through the points; a null value breaks the line, so missing
 * days are never interpolated.
 */
export function linePath(
  values: ReadonlyArray<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      open = false;
      return;
    }
    d += `${open ? "L" : "M"}${round(x(i))},${round(y(v))}`;
    open = true;
  });
  return d;
}

const round = (n: number) => Math.round(n * 100) / 100;

// ---------- run timeline ----------

export type TimelineOffsets = {
  created: number;
  waitEnd: number | null;
  started: number | null;
  completed: number | null;
};

export type SegmentKind = "queue" | "wait" | "run";
export type Segment = { kind: SegmentKind; from: number; to: number };

/**
 * Queue, approval-wait and execution segments of one job, in seconds from
 * the start of the attempt. A job still running extends to `now`; a job
 * still queued shows its queue up to `now`.
 */
export function timelineSegments(
  o: TimelineOffsets,
  waitingS: number,
  now: number,
): Segment[] {
  const out: Segment[] = [];
  const end = o.completed ?? now;
  const queueEnd = o.started ?? (o.completed != null ? o.completed : now);
  const push = (kind: SegmentKind, from: number, to: number) => {
    if (to > from) out.push({ kind, from, to });
  };
  if (o.waitEnd != null && waitingS > 0) {
    const waitStart = Math.max(o.created, o.waitEnd - waitingS);
    push("queue", o.created, Math.min(waitStart, queueEnd));
    push("wait", waitStart, Math.min(o.waitEnd, queueEnd));
    push("queue", Math.max(o.waitEnd, o.created), queueEnd);
  } else {
    push("queue", o.created, queueEnd);
  }
  if (o.started != null) push("run", o.started, Math.max(o.started, end));
  return out;
}

/**
 * Critical path (design §6.2): starting from the job that finished last,
 * walk back through predecessors that ended at most `slackS` seconds before
 * the current job started. Returns the ids on the path.
 */
export function criticalPath(
  jobs: ReadonlyArray<{
    id: string;
    started: number | null;
    completed: number | null;
  }>,
  slackS = 5,
): Set<string> {
  const done = jobs.filter(
    (j): j is { id: string; started: number; completed: number } =>
      j.started != null && j.completed != null,
  );
  const path = new Set<string>();
  let current = done.reduce<(typeof done)[number] | undefined>(
    (best, j) => (!best || j.completed > best.completed ? j : best),
    undefined,
  );
  while (current && !path.has(current.id)) {
    path.add(current.id);
    const start: number = current.started;
    current = done
      .filter(
        (j) =>
          !path.has(j.id) &&
          j.completed <= start &&
          start - j.completed <= slackS,
      )
      .reduce<(typeof done)[number] | undefined>(
        (best, j) => (!best || j.completed > best.completed ? j : best),
        undefined,
      );
  }
  return path;
}
