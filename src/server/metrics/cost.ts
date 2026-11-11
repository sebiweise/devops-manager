import type { RunnerKind, SkuRateLike } from "./classify";

/**
 * Per-job minute and cost estimates (design §6.6). Rates come from the
 * SkuRate table, nothing is hard-coded here. M1 shows minutes only.
 */

/** The rate of `sku` whose effectiveFrom is the latest one on or before `day`. */
export function rateFor(
  rates: ReadonlyArray<SkuRateLike>,
  sku: string,
  day: Date,
): SkuRateLike | null {
  let best: SkuRateLike | null = null;
  for (const rate of rates) {
    if (rate.sku !== sku) continue;
    if (rate.effectiveFrom.getTime() > day.getTime()) continue;
    if (!best || rate.effectiveFrom > best.effectiveFrom) best = rate;
  }
  return best;
}

export type CostInput = {
  kind: RunnerKind;
  sku: string | null;
  durationS: number | null;
  repoPrivate: boolean;
  /** The day the job ran (its start, else its creation). */
  day: Date;
};

export type CostEstimate = {
  /** Whole minutes as GitHub rounds them (each job rounds up). */
  rawMin: number;
  /** rawMin x minuteMultiplier, rounded to whole minutes. */
  billableMinEst: number;
  estUsd: number;
};

/**
 * Null while the job has no duration. Zero for self-hosted and unknown
 * runners, for standard hosted runners in public repositories (free), and for
 * larger runners without a matching SKU (flagged, excluded from estimates).
 */
export function estimateJobCost(
  input: CostInput,
  rates: ReadonlyArray<SkuRateLike>,
): CostEstimate | null {
  if (input.durationS == null) return null;
  const rawMin = Math.ceil(Math.max(0, input.durationS) / 60);
  const free = { rawMin, billableMinEst: 0, estUsd: 0 };
  if (input.kind === "SELF_HOSTED" || input.kind === "UNKNOWN") return free;
  if (input.kind === "GITHUB_HOSTED" && !input.repoPrivate) return free;
  if (!input.sku) return free;
  const rate = rateFor(rates, input.sku, input.day);
  if (!rate) return free;
  return {
    rawMin,
    billableMinEst: Math.round(rawMin * rate.minuteMultiplier),
    estUsd: Math.round(rawMin * rate.pricePerMinuteUsd * 10_000) / 10_000,
  };
}
