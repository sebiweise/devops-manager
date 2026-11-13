/**
 * Pure view helpers of the hosting (Vercel) pages: state badges, the Hobby
 * daily deployment allotment and the deployments-per-day series. Client-safe.
 */

/** Vercel Hobby: deployments created per day (docs: Limits, 86 400 s window). */
export const HOBBY_DAILY_DEPLOYMENTS = 100;
/** Vercel Pro: deployments created per day. */
export const PRO_DAILY_DEPLOYMENTS = 6000;

export const DEPLOYMENT_STATES = [
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "READY",
  "ERROR",
  "CANCELED",
  "BLOCKED",
  "DELETED",
  "UNKNOWN",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export const NON_TERMINAL_STATES: readonly DeploymentState[] = [
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
];

export type DeployBadgeKind =
  | "deployReady"
  | "deployError"
  | "deployBuilding"
  | "deployQueued"
  | "deployCanceled"
  | "deployBlocked"
  | "deployUnknown";

/** The badge of a deployment state (DELETED shows as unknown). */
export function deployBadgeKind(
  state: string | null | undefined,
): DeployBadgeKind {
  switch (state) {
    case "READY":
      return "deployReady";
    case "ERROR":
      return "deployError";
    case "BUILDING":
    case "INITIALIZING":
      return "deployBuilding";
    case "QUEUED":
      return "deployQueued";
    case "CANCELED":
      return "deployCanceled";
    case "BLOCKED":
      return "deployBlocked";
    default:
      return "deployUnknown";
  }
}

/** The plan's daily allotment, or null when the plan is unknown or custom. */
export function dailyAllotment(plan: string | null | undefined): number | null {
  if (plan === "hobby") return HOBBY_DAILY_DEPLOYMENTS;
  if (plan === "pro") return PRO_DAILY_DEPLOYMENTS;
  return null;
}

/** Share of the daily allotment used in the last 24 h (may exceed 1). */
export function quotaRatio(
  last24h: number,
  plan: string | null | undefined,
): number | null {
  const cap = dailyAllotment(plan);
  return cap ? last24h / cap : null;
}

export type DeployDay = {
  day: string;
  ready: number;
  error: number;
  canceled: number;
  /** total - ready - error - canceled (building, queued, blocked, unknown) */
  other: number;
};

/** Fills the days of a window with zeros, in order. */
export function fillDays(
  days: ReadonlyArray<string>,
  rows: ReadonlyArray<{
    day: string;
    total: number;
    ready: number;
    error: number;
    canceled: number;
  }>,
): DeployDay[] {
  const by = new Map<string, DeployDay>();
  for (const r of rows) {
    const acc = by.get(r.day) ?? {
      day: r.day,
      ready: 0,
      error: 0,
      canceled: 0,
      other: 0,
    };
    acc.ready += r.ready;
    acc.error += r.error;
    acc.canceled += r.canceled;
    acc.other += Math.max(0, r.total - r.ready - r.error - r.canceled);
    by.set(r.day, acc);
  }
  return days.map(
    (day) => by.get(day) ?? { day, ready: 0, error: 0, canceled: 0, other: 0 },
  );
}

/** Ready share of finished deployments (canceled ones excluded), or null. */
export function deploySuccessRate(ready: number, error: number): number | null {
  const n = ready + error;
  return n > 0 ? ready / n : null;
}

/** Short commit SHA for display. */
export function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}
