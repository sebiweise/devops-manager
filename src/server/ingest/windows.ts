/**
 * Time windows for `GET /repos/{o}/{r}/actions/runs?created=a..b`.
 *
 * GitHub's list endpoints return at most 1,000 results per search, whatever
 * the pagination. A window whose `total_count` reaches 1,000 is split in half
 * recursively until each part is below the cap (design §5.3 e). Windows are
 * whole seconds, inclusive on both ends, as GitHub's `created` filter is.
 */

export const RESULT_CAP = 1000;
export const BACKFILL_WINDOW_DAYS = 3;

export type Window = {
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, inclusive. */
  to: number;
};

export function windowOf(from: Date, to: Date): Window {
  return {
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(to.getTime() / 1000),
  };
}

const iso = (s: number) =>
  new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The `created` query value for a window. */
export function createdQuery(w: Window): string {
  return `${iso(w.from)}..${iso(w.to)}`;
}

/** Splits at the midpoint: [from, mid] and [mid + 1, to]. */
export function halves(w: Window): [Window, Window] {
  const mid = Math.floor((w.from + w.to) / 2);
  return [
    { from: w.from, to: mid },
    { from: mid + 1, to: w.to },
  ];
}

/**
 * Leaf windows below the result cap, newest first, so backfill can persist
 * its progress (`backfillUntil = leaf.from`) after each leaf. A one-second
 * window cannot be split further and is returned as is.
 */
export async function planWindows(
  w: Window,
  count: (w: Window) => Promise<number>,
  cap: number = RESULT_CAP,
): Promise<Window[]> {
  if (w.to < w.from) return [];
  const total = await count(w);
  if (total < cap || w.to === w.from) return total === 0 ? [] : [w];
  const [older, newer] = halves(w);
  return [
    ...(await planWindows(newer, count, cap)),
    ...(await planWindows(older, count, cap)),
  ];
}

/**
 * The next backfill window below `until` (exclusive), at most three days long
 * and never older than `target`. Null when the backfill is complete.
 */
export function nextBackfillWindow(
  until: Date,
  target: Date,
  days: number = BACKFILL_WINDOW_DAYS,
): Window | null {
  const to = Math.floor(until.getTime() / 1000) - 1;
  const floor = Math.floor(target.getTime() / 1000);
  if (to < floor) return null;
  return { from: Math.max(floor, to - days * 86_400 + 1), to };
}
