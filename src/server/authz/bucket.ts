/** Token bucket arithmetic shared by the SQL limiter and its tests (pure). */

export type BucketSpec = { capacity: number; refillPerSecond: number };

/** 30 mutations per minute per user (design §8.1 step 5). */
export const ACTION_BUCKET: BucketSpec = {
  capacity: 30,
  refillPerSecond: 30 / 60,
};

/** Tokens after `elapsedS` seconds of refill, capped at the capacity. */
export function refill(
  tokens: number,
  elapsedS: number,
  spec: BucketSpec,
): number {
  return Math.min(
    spec.capacity,
    tokens + Math.max(0, elapsedS) * spec.refillPerSecond,
  );
}
