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
