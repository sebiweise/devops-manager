import "server-only";
import { db } from "@/server/db";
import type { SkuRateLike } from "@/server/metrics/classify";
import { SEED_RATES } from "@/server/metrics/sku-seed";

/**
 * SkuRate access for the fold (design §6.6). The table is seeded from
 * prisma/seed/sku-rates.json once (idempotent, rows that exist are kept, so
 * admin edits survive) and cached in memory for five minutes, so a changed
 * rate reaches new estimates without a deploy.
 */

const CACHE_MS = 5 * 60 * 1000;

let cache: { at: number; rates: SkuRateLike[] } | null = null;
let seeded = false;

/** Inserts the seed rows that do not exist yet. */
export async function ensureSkuRates(): Promise<void> {
  if (seeded) return;
  await db.skuRate.createMany({
    data: SEED_RATES.map((r) => ({
      sku: r.sku,
      os: r.os,
      cores: r.cores,
      labelPattern: r.labelPattern,
      minuteMultiplier: r.minuteMultiplier,
      pricePerMinuteUsd: r.pricePerMinuteUsd,
      effectiveFrom: new Date(`${r.effectiveFrom}T00:00:00.000Z`),
    })),
    skipDuplicates: true,
  });
  seeded = true;
}

export async function loadSkuRates(): Promise<SkuRateLike[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rates;
  await ensureSkuRates();
  const rows = await db.skuRate.findMany({
    orderBy: [{ sku: "asc" }, { effectiveFrom: "asc" }],
  });
  const rates = rows.map((r) => ({
    sku: r.sku,
    os: r.os,
    labelPattern: r.labelPattern,
    minuteMultiplier: Number(r.minuteMultiplier),
    pricePerMinuteUsd: Number(r.pricePerMinuteUsd),
    effectiveFrom: r.effectiveFrom,
  }));
  cache = { at: Date.now(), rates };
  return rates;
}

/** Drops the in-memory cache (tests, SkuRate edits). */
export function forgetSkuRates(): void {
  cache = null;
  seeded = false;
}
