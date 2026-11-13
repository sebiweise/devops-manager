/**
 * Pure usage math of Azure Pipelines (design addendum M7 §5.2): the billing
 * month from `monthResetDay`, the parallel-job sweep over job intervals,
 * the free-tier quota figures and the API-versus-estimate note. Client-safe
 * and unit-tested; the Usage page, the findings and the dialogs share it.
 */

export const FREE_TIER_MINUTES = 1800;
export const FREE_TIER_JOB_MINUTES = 60;
export const PAID_TIER_JOB_MINUTES = 360;
/** API and estimate disagree when they differ by more than this share. */
export const USAGE_NOTE_SHARE = 0.05;

const DAY_MS = 86_400_000;

export type BillingMonth = {
  /** "YYYY-MM" of the month the window starts in. */
  key: string;
  /** Local days "YYYY-MM-DD", inclusive start and exclusive end. */
  startDay: string;
  endDay: string;
  /** Days of the window, elapsed days including today. */
  totalDays: number;
  elapsedDays: number;
  /** Days until the reset (the end day). */
  daysLeft: number;
};

function ymd(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10);
}

function clampDay(y: number, m: number, day: number): number {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(day, last);
}

/**
 * The billing window around `today` ("YYYY-MM-DD", the installation's
 * local day): from the latest `resetDay` on or before today to the next
 * one. Azure DevOps does not document the reset; the calendar month
 * (resetDay 1) is assumed and labelled so.
 */
export function billingMonth(today: string, resetDay: number): BillingMonth {
  const day = Math.min(28, Math.max(1, Math.round(resetDay)));
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  let sy = y;
  let sm = m;
  if (d < clampDay(y, m, day)) {
    sm -= 1;
    if (sm === 0) {
      sm = 12;
      sy -= 1;
    }
  }
  let ey = sy;
  let em = sm + 1;
  if (em === 13) {
    em = 1;
    ey += 1;
  }
  const startDay = ymd(sy, sm, clampDay(sy, sm, day));
  const endDay = ymd(ey, em, clampDay(ey, em, day));
  const start = Date.parse(`${startDay}T00:00:00Z`);
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  const totalDays = Math.round((end - start) / DAY_MS);
  return {
    key: startDay.slice(0, 7),
    startDay,
    endDay,
    totalDays,
    elapsedDays: Math.min(totalDays, Math.round((now - start) / DAY_MS) + 1),
    daysLeft: Math.max(0, Math.round((end - now) / DAY_MS)),
  };
}

export type Interval = { start: number; end: number };

/**
 * The peak of concurrently running intervals and the seconds during which
 * at least `limit` ran at once (every parallel job busy), clipped to
 * [from, to).
 */
export function sweepIntervals(
  intervals: ReadonlyArray<Interval>,
  limit: number,
  from: number,
  to: number,
): { peak: number; saturatedS: number } {
  const events: Array<[number, number]> = [];
  for (const i of intervals) {
    const s = Math.max(from, i.start);
    const e = Math.min(to, i.end);
    if (e <= s) continue;
    events.push([s, 1], [e, -1]);
  }
  // Ends before starts at the same instant: back-to-back jobs do not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let peak = 0;
  let saturatedMs = 0;
  let last = from;
  for (const [t, delta] of events) {
    if (running >= Math.max(1, limit)) saturatedMs += t - last;
    running += delta;
    peak = Math.max(peak, running);
    last = t;
  }
  return { peak, saturatedS: Math.round(saturatedMs / 1000) };
}

/** MTD + (MTD / elapsed) × remaining, like the GitHub projection. */
export function projectWindow(
  used: number,
  w: Pick<BillingMonth, "elapsedDays" | "totalDays">,
): number {
  if (w.elapsedDays <= 0) return 0;
  if (w.elapsedDays >= w.totalDays) return used;
  return used + (used / w.elapsedDays) * (w.totalDays - w.elapsedDays);
}

/**
 * The local day the projection reaches `included` ("limit reached around
 * the 26th"), or null when it stays below.
 */
export function limitDay(
  used: number,
  included: number,
  w: BillingMonth,
): string | null {
  if (included <= 0) return w.startDay;
  if (used >= included) return null;
  const perDay = w.elapsedDays > 0 ? used / w.elapsedDays : 0;
  if (perDay <= 0) return null;
  const dayIndex = Math.ceil(included / perDay) - 1;
  if (dayIndex >= w.totalDays) return null;
  const start = Date.parse(`${w.startDay}T00:00:00Z`);
  return new Date(start + dayIndex * DAY_MS).toISOString().slice(0, 10);
}

/** Both figures, and whether they differ by more than 5 %. */
export function usageNote(
  api: number | null,
  estimate: number | null,
): {
  shown: number | null;
  source: "api" | "estimate" | null;
  differs: boolean;
} {
  if (api == null && estimate == null)
    return { shown: null, source: null, differs: false };
  if (api == null)
    return { shown: estimate, source: "estimate", differs: false };
  const differs =
    estimate != null &&
    Math.abs(api - estimate) > USAGE_NOTE_SHARE * Math.max(api, estimate, 1);
  return { shown: api, source: "api", differs };
}

export type QuotaLevel = "ok" | "warning" | "exceeded" | "unlimited";

/** ≥ 100 % exceeded; ≥ 80 %, or a projection over the limit with ≥ 7 days left: warning. */
export function quotaLevel(
  used: number,
  included: number | null,
  projected: number,
  daysLeft: number,
): QuotaLevel {
  if (included == null) return "unlimited";
  if (used >= included) return "exceeded";
  if (used >= included * 0.8 || (projected > included && daysLeft >= 7))
    return "warning";
  return "ok";
}

/**
 * The dialog warning before queue and retry (design addendum §7.2): the
 * definition's p90 exceeds the minutes left, or comes within 10 minutes of
 * the job time limit.
 */
export function runWarning(input: {
  minutesLeft: number | null;
  p90Minutes: number | null;
  maxJobMinutes: number;
}): { quota: boolean; jobCap: boolean } {
  const p90 = input.p90Minutes;
  return {
    quota:
      input.minutesLeft != null &&
      (input.minutesLeft <= 0 || (p90 != null && p90 > input.minutesLeft)),
    jobCap: p90 != null && p90 >= input.maxJobMinutes - 10,
  };
}

/** GitHub-equivalent billable minutes of Azure macOS minutes (× the SKU multiplier). */
export function githubEquivalent(
  azureMacosMinutes: number,
  multiplier: number,
  pricePerMinuteUsd: number | null,
): { minutes: number; usd: number | null } {
  const minutes = Math.round(azureMacosMinutes * multiplier);
  return {
    minutes,
    usd:
      pricePerMinuteUsd == null
        ? null
        : Math.round(azureMacosMinutes * pricePerMinuteUsd * 100) / 100,
  };
}
