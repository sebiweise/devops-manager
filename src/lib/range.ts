/**
 * The shared time range of the insights pages (UI overhaul §4.3): read from
 * `?range=`, then from the `dm_range` cookie the range control writes,
 * defaulting to 7 days. Each range has one chart bucket: 24 h hourly,
 * 7 and 30 days daily, 90 days weekly, 12 months monthly.
 *
 * Pure and client-safe; the server reads the cookie and passes its value.
 */

export const RANGES = ["24h", "7d", "30d", "90d", "12m"] as const;
export type InsightRange = (typeof RANGES)[number];

export const DEFAULT_RANGE: InsightRange = "7d";
export const RANGE_COOKIE = "dm_range";
/** One year; the choice is a preference, not a secret. */
export const RANGE_COOKIE_MAX_AGE_S = 365 * 86_400;

export type RangeBucket = "hour" | "day" | "week" | "month";

export const RANGE_BUCKET: Record<InsightRange, RangeBucket> = {
  "24h": "hour",
  "7d": "day",
  "30d": "day",
  "90d": "week",
  "12m": "month",
};

export const RANGE_DAYS: Record<InsightRange, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "12m": 365,
};

export function isRange(value: unknown): value is InsightRange {
  return (
    typeof value === "string" && (RANGES as readonly string[]).includes(value)
  );
}

/** A range value, or `fallback` when it is missing or unknown. */
export function parseRange(
  value: string | null | undefined,
  fallback: InsightRange = DEFAULT_RANGE,
): InsightRange {
  return isRange(value) ? value : fallback;
}

/** `?range=` wins, then the cookie, then the default. */
export function resolveRange(
  param: string | null | undefined,
  cookie: string | null | undefined,
  fallback: InsightRange = DEFAULT_RANGE,
): InsightRange {
  if (isRange(param)) return param;
  if (isRange(cookie)) return cookie;
  return fallback;
}

export function rangeStart(range: InsightRange, now: Date): Date {
  return new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000);
}

/** The `Set-Cookie` attributes of the range cookie (client and server). */
export function rangeCookie(range: InsightRange): string {
  return `${RANGE_COOKIE}=${range}; Path=/; Max-Age=${RANGE_COOKIE_MAX_AGE_S}; SameSite=Lax`;
}

/**
 * Start of the bucket that contains `day` ("YYYY-MM-DD"): the day itself,
 * the Monday of its ISO week, or the first of its month.
 */
export function bucketOf(day: string, bucket: RangeBucket): string {
  if (bucket === "day" || bucket === "hour") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const d = new Date(`${day}T00:00:00.000Z`);
  const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - weekday * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Groups daily points into the range's buckets, summing `keys`. Hourly
 * ranges keep the daily points (hourly data is not stored per day).
 */
export function bucketDays<T extends { day: string }>(
  points: ReadonlyArray<T>,
  bucket: RangeBucket,
  keys: ReadonlyArray<keyof T>,
): Array<{ bucket: string } & Partial<Record<keyof T, number>>> {
  const out = new Map<string, { bucket: string } & Record<string, number>>();
  for (const p of points) {
    const b = bucketOf(p.day, bucket);
    const acc =
      out.get(b) ??
      ({ bucket: b } as { bucket: string } & Record<string, number>);
    for (const k of keys) {
      const v = Number(p[k] ?? 0);
      acc[k as string] = (acc[k as string] ?? 0) + (Number.isFinite(v) ? v : 0);
    }
    out.set(b, acc);
  }
  return [...out.values()] as Array<
    { bucket: string } & Partial<Record<keyof T, number>>
  >;
}
