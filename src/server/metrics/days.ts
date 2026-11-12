import { RANGE_DAYS, type InsightRange } from "@/lib/range";

/**
 * Calendar days in an installation's timezone. Rollups bucket by local day;
 * the database stores a day as a `date`, which Prisma maps to UTC midnight.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** "YYYY-MM-DD" of `instant` in `timeZone` (invalid zones fall back to UTC). */
export function localDay(instant: Date, timeZone: string): string {
  return formatter(timeZone).format(instant);
}

/** The local day of `instant` as a `date` value (UTC midnight). */
export function localDayDate(instant: Date, timeZone: string): Date {
  return new Date(`${localDay(instant, timeZone)}T00:00:00.000Z`);
}

/** `date` value -> "YYYY-MM-DD". */
export function dayString(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * 86_400_000);
}

/** Every day from `from` to `to` inclusive, as "YYYY-MM-DD". */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d.getTime() <= end.getTime() && out.length < 1000) {
    out.push(dayString(d));
    d = addDays(d, 1);
  }
  return out;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    };
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
    }
    offsetFormatters.set(timeZone, f);
  }
  return f;
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    offsetFormatter(timeZone)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The instant local midnight of `day` ("YYYY-MM-DD") in `timeZone`. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  let t = midnight - offsetMs(midnight, timeZone);
  // Second pass for a DST change between UTC and local midnight.
  t = midnight - offsetMs(t, timeZone);
  return new Date(t);
}

/**
 * A time window of the insights pages (UI overhaul §4.3): raw rows are read
 * over [from, to), daily rollups over fromDay..toDay (both inclusive, local
 * days of the installation). The two always describe the same days, so a
 * figure from runs and one from rollups agree.
 */
export type DayWindow = {
  from: Date;
  to: Date;
  fromDay: string;
  toDay: string;
};

/** The last `days` calendar days including today, in `timeZone`. */
export function lastDaysWindow(
  days: number,
  now: Date,
  timeZone: string,
): DayWindow {
  const toDay = localDay(now, timeZone);
  const fromDay = dayString(
    addDays(new Date(`${toDay}T00:00:00.000Z`), -(Math.max(1, days) - 1)),
  );
  return { from: startOfLocalDay(fromDay, timeZone), to: now, fromDay, toDay };
}

/**
 * The window of a range: "24h" is the rolling last 24 hours; every other
 * range is the last N calendar days including today ("7d" = today and the
 * 6 days before), so the daily chart has exactly N bars.
 */
export function rangeWindow(
  range: InsightRange,
  now: Date,
  timeZone: string,
): DayWindow {
  if (range === "24h") {
    const from = new Date(now.getTime() - 86_400_000);
    return {
      from,
      to: now,
      fromDay: localDay(from, timeZone),
      toDay: localDay(now, timeZone),
    };
  }
  return lastDaysWindow(RANGE_DAYS[range], now, timeZone);
}

/** The same number of calendar days right before `w` (trend deltas). */
export function previousWindow(w: DayWindow, timeZone: string): DayWindow {
  const days = daysBetween(w.fromDay, w.toDay).length;
  const toDay = dayString(addDays(new Date(`${w.fromDay}T00:00:00.000Z`), -1));
  const fromDay = dayString(
    addDays(new Date(`${toDay}T00:00:00.000Z`), -(days - 1)),
  );
  return {
    from: startOfLocalDay(fromDay, timeZone),
    to: w.from,
    fromDay,
    toDay,
  };
}
