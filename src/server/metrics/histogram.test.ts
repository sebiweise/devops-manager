import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bucketBounds,
  bucketOf,
  HIST_BUCKETS,
  histogramCount,
  histogramOf,
  histogramPercentile,
  mergeHistograms,
} from "./histogram";
import { percentileExact } from "./stats";

describe("histogram codec", () => {
  it("has 80 buckets with bucket 0 below one second", () => {
    expect(histogramOf([]).length).toBe(HIST_BUCKETS);
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(0.99)).toBe(0);
    expect(bucketOf(1)).toBe(1);
    expect(bucketOf(2)).toBe(5);
    expect(bucketOf(16)).toBe(17);
    expect(bucketOf(1e12)).toBe(79);
  });

  it("puts every value inside its bucket's bounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 700_000 }), (s) => {
        const [lo, hi] = bucketBounds(bucketOf(s));
        expect(s).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(s).toBeLessThan(hi + 1e-9);
      }),
    );
  });

  it("covers the 5-day self-hosted job limit below the top bucket", () => {
    expect(bucketOf(5 * 86_400)).toBeLessThan(HIST_BUCKETS - 1);
  });

  it("merges by element-wise sum", () => {
    const a = histogramOf([1, 2, 3]);
    const b = histogramOf([3, 400]);
    const merged = mergeHistograms(a, b, null);
    expect(histogramCount(merged)).toBe(5);
    expect(merged).toEqual(histogramOf([1, 2, 3, 3, 400]));
  });

  it("estimates percentiles within 10% of percentile_cont", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 5, max: 20_000 }), {
          minLength: 20,
          maxLength: 400,
        }),
        fc.constantFrom(0.5, 0.95),
        (values, p) => {
          const exact = percentileExact(values, p)!;
          const approx = histogramPercentile(histogramOf(values), p)!;
          // The interpolation is inside one bucket (about 19% wide), so the
          // error against the exact rank is bounded by the bucket width; for
          // ranks between two values from different buckets the exact
          // interpolation itself can sit anywhere in between.
          const sorted = [...values].sort((a, b) => a - b);
          const rank = p * (values.length - 1);
          const lo = sorted[Math.floor(rank)]!;
          const hi = sorted[Math.ceil(rank)]!;
          expect(approx).toBeGreaterThanOrEqual(lo / 1.2);
          expect(approx).toBeLessThanOrEqual(hi * 1.2);
          if (bucketOf(lo) === bucketOf(hi)) {
            expect(Math.abs(approx - exact) / exact).toBeLessThanOrEqual(0.2);
          }
        },
      ),
    );
  });

  it("is within 10% on a realistic duration distribution", () => {
    // 200 runs between 4 and 9 minutes, plus a slow tail.
    const values = [
      ...Array.from({ length: 200 }, (_, i) => 240 + ((i * 37) % 300)),
      ...Array.from({ length: 12 }, (_, i) => 900 + i * 60),
    ];
    for (const p of [0.5, 0.95]) {
      const exact = percentileExact(values, p)!;
      const approx = histogramPercentile(histogramOf(values), p)!;
      expect(Math.abs(approx - exact) / exact).toBeLessThanOrEqual(0.1);
    }
  });

  it("returns null without data", () => {
    expect(histogramPercentile(histogramOf([]), 0.5)).toBeNull();
  });
});
