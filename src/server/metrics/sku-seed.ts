import seed from "../../../prisma/seed/sku-rates.json";
import type { RunnerOs, SkuRateLike } from "./classify";

/** The default SKU rates shipped in prisma/seed/sku-rates.json. */

export type SeedRate = {
  sku: string;
  os: RunnerOs;
  cores: number | null;
  labelPattern: string | null;
  minuteMultiplier: number;
  pricePerMinuteUsd: number;
  effectiveFrom: string;
};

export const SEED_RATES: SeedRate[] = (seed as { rates: SeedRate[] }).rates;

export function seedRatesAsRows(): SkuRateLike[] {
  return SEED_RATES.map((r) => ({
    sku: r.sku,
    os: r.os,
    labelPattern: r.labelPattern,
    minuteMultiplier: r.minuteMultiplier,
    pricePerMinuteUsd: r.pricePerMinuteUsd,
    effectiveFrom: new Date(`${r.effectiveFrom}T00:00:00.000Z`),
  }));
}
