/**
 * Display formatting for Actions insights. Pure functions, shared by server
 * and client components; numbers that come from histograms are prefixed with
 * "~" (design §5.5).
 */

export const EMPTY = "—";

/** 42s, 5m 03s, 2h 05m, 1d 3h. Null and negative values render as "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return EMPTY;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return `${d}d ${h}h`;
}

/** A rate in 0..1 as a percentage, e.g. 0.934 -> "93.4%" (en). */
export function formatPercent(
  rate: number | null | undefined,
  locale = "en",
  digits = 1,
): string {
  if (rate == null || !Number.isFinite(rate)) return EMPTY;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(rate);
}

/** A difference of two rates in percentage points, signed: "+2.1 pp". */
export function formatPointsDelta(
  delta: number | null | undefined,
  locale = "en",
): string {
  if (delta == null || !Number.isFinite(delta)) return EMPTY;
  const points = delta * 100;
  const n = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(points);
  return `${n} pp`;
}

export function formatNumber(
  value: number | null | undefined,
  locale = "en",
): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    value,
  );
}

/** Estimated billable minutes are shown as whole minutes only (M1). */
export function formatMinutes(
  value: number | null | undefined,
  locale = "en",
): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return `${formatNumber(Math.round(value), locale)} min`;
}

/** A relative change, signed and whole: 0.25 -> "+25%", -0.1 -> "-10%". */
export function formatSignedPercent(
  value: number | null | undefined,
  locale = "en",
): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(value);
}

/** US dollars with cents, e.g. 1234.5 -> "$1,234.50" (en). */
export function formatUsd(
  value: number | null | undefined,
  locale = "en",
): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** A ratio with two decimals, e.g. a speed index of 0.8 -> "0.80". */
export function formatRatio(
  value: number | null | undefined,
  locale = "en",
): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Prefixes approximate values (from histograms) with "~". */
export function approx(text: string, isApprox: boolean): string {
  return isApprox && text !== EMPTY ? `~${text}` : text;
}

/** First 7 characters of a commit sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
