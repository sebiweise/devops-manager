import "server-only";
import { db } from "@/server/db";
import { ACTION_BUCKET, refill, type BucketSpec } from "./bucket";

/**
 * Mutation rate limit (design §8.1 step 5): a token bucket per user in
 * Postgres (`RateLimitBucket`, key `action:<userId>`), 30 mutations per
 * minute. Bulk operations take one token per item. The check and the
 * withdrawal are one statement, so concurrent requests cannot both spend the
 * last token.
 *
 * A bulk larger than the bucket is allowed when the bucket is full and
 * drives it negative, which delays the user's next mutations accordingly.
 */

export type RateDecision = { ok: true } | { ok: false; retryAfterS: number };

export async function consumeActionTokens(
  userId: string,
  cost: number,
  now: Date = new Date(),
  spec: BucketSpec = ACTION_BUCKET,
): Promise<RateDecision> {
  const key = `action:${userId}`;
  const need = Math.min(cost, spec.capacity);
  const rows = await db.$queryRaw<Array<{ tokens: number }>>`
    INSERT INTO "RateLimitBucket" ("key", "tokens", "updatedAt")
    VALUES (${key}, ${spec.capacity - cost}::float8, ${now}::timestamptz)
    ON CONFLICT ("key") DO UPDATE SET
      "tokens" = LEAST(${spec.capacity}::float8, "RateLimitBucket"."tokens"
        + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - "RateLimitBucket"."updatedAt")))::float8
        * ${spec.refillPerSecond}::float8) - ${cost}::float8,
      "updatedAt" = GREATEST("RateLimitBucket"."updatedAt", ${now}::timestamptz)
    WHERE LEAST(${spec.capacity}::float8, "RateLimitBucket"."tokens"
        + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - "RateLimitBucket"."updatedAt")))::float8
        * ${spec.refillPerSecond}::float8) >= ${need}::float8
    RETURNING "tokens"`;
  if (rows.length === 1) return { ok: true };

  const bucket = await db.rateLimitBucket.findUnique({ where: { key } });
  const available = bucket
    ? refill(
        bucket.tokens,
        (now.getTime() - bucket.updatedAt.getTime()) / 1000,
        spec,
      )
    : spec.capacity;
  return {
    ok: false,
    retryAfterS: Math.max(
      1,
      Math.ceil((need - available) / spec.refillPerSecond),
    ),
  };
}
