import type { Costs } from "@/server/data/costs";

/**
 * View logic of the costs page (design §6.6, §7 /costs): month navigation
 * and the geometry of the used vs included gauge. Pure functions.
 */

/** "2026-11" -> the previous and next month labels. */
export function adjacentMonths(month: string): { prev: string; next: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const at = (offset: number) => {
    const d = new Date(Date.UTC(y, m - 1 + offset, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return { prev: at(-1), next: at(1) };
}

export function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type GaugeGeometry = {
  /** Percent of the scale (0..100). */
  usedPct: number;
  projectedPct: number;
  includedPct: number;
  /** Used share of the included minutes (may exceed 1). */
  usedOfIncluded: number | null;
  overIncluded: boolean;
  projectedOverIncluded: boolean;
};

/**
 * The scale is the largest of included, used and projected, so the included
 * marker, the used bar and the projection always fit.
 */
export function gaugeGeometry(included: Costs["included"]): GaugeGeometry {
  const used = Math.max(0, included.used);
  const projected = Math.max(used, included.projectedUsed);
  const scale = Math.max(included.included, projected, 1);
  const pct = (v: number) => Math.min(100, (v / scale) * 100);
  return {
    usedPct: pct(used),
    projectedPct: pct(projected),
    includedPct: pct(included.included),
    usedOfIncluded: included.included > 0 ? used / included.included : null,
    overIncluded: included.included > 0 && used > included.included,
    projectedOverIncluded:
      included.included > 0 && projected > included.included,
  };
}

/** Admins get a link to /admin/github for the reasons a credential fixes. */
export function credentialFixable(
  reason: Costs["reason"],
  accountType: "USER" | "ORGANIZATION",
): boolean {
  return (
    accountType === "USER" &&
    (reason === "no_credential" || reason === "credential_error")
  );
}
