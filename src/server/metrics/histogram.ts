/**
 * Mergeable duration histograms (design §6.8).
 *
 * 80 buckets. Bucket 0 holds values below one second; bucket i (1..79) covers
 * `[2^((i-1)/4), 2^(i/4))` seconds, so each bucket is about 19% wide and the
 * top bucket also collects everything above about ten days. Histograms of
 * different days merge by element-wise addition (`hist_sum` in SQL).
 *
 * The same rules exist in SQL (`hist_bucket`, `hist_add`, `hist_agg`,
 * `hist_sum` in the M1 migration); an integration test checks that both agree.
 */

export const HIST_BUCKETS = 80;

/** Guards against floating-point error at exact powers of two. */
const EPSILON = 1e-9;

export type Histogram = number[];

export function emptyHistogram(): Histogram {
  return new Array<number>(HIST_BUCKETS).fill(0);
}

export function bucketOf(seconds: number): number {
  if (!(seconds >= 1)) return 0;
  return Math.min(
    HIST_BUCKETS - 1,
    Math.floor(4 * Math.log2(seconds) + EPSILON) + 1,
  );
}

/** Lower and upper bound of a bucket, in seconds. */
export function bucketBounds(bucket: number): [number, number] {
  if (bucket <= 0) return [0, 1];
  return [2 ** ((bucket - 1) / 4), 2 ** (bucket / 4)];
}

export function addToHistogram(hist: Histogram, seconds: number): Histogram {
  hist[bucketOf(seconds)]! += 1;
  return hist;
}

export function histogramOf(values: Iterable<number>): Histogram {
  const hist = emptyHistogram();
  for (const v of values) addToHistogram(hist, v);
  return hist;
}

/** Element-wise sum; missing or short arrays count as zeros. */
export function mergeHistograms(
  ...hists: ReadonlyArray<ReadonlyArray<number> | null | undefined>
): Histogram {
  const out = emptyHistogram();
  for (const h of hists) {
    if (!h) continue;
    for (let i = 0; i < HIST_BUCKETS; i++) out[i]! += h[i] ?? 0;
  }
  return out;
}

export function histogramCount(hist: ReadonlyArray<number>): number {
  let n = 0;
  for (const c of hist) n += c;
  return n;
}

/**
 * Approximate percentile (0..1). Uses the same rank as `percentile_cont`
 * (`p * (n - 1)`), finds the bucket that holds it and interpolates
 * geometrically inside the bucket (linearly in bucket 0). The error is
 * bounded by the bucket width, about 9% around the bucket's geometric centre.
 */
export function histogramPercentile(
  hist: ReadonlyArray<number>,
  p: number,
): number | null {
  const n = histogramCount(hist);
  if (n === 0) return null;
  const rank = Math.min(Math.max(p, 0), 1) * (n - 1);
  let seen = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const count = hist[i] ?? 0;
    if (count === 0) continue;
    if (rank < seen + count) {
      // Position inside the bucket, centred on its values: 0.5/count .. 1-0.5/count.
      const within = (rank - seen + 0.5) / count;
      const [lo, hi] = bucketBounds(i);
      if (i === 0) return lo + (hi - lo) * within;
      return lo * (hi / lo) ** within;
    }
    seen += count;
  }
  const [, hi] = bucketBounds(HIST_BUCKETS - 1);
  return hi;
}
