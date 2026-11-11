import "server-only";
import { db } from "@/server/db";
import { RateBudget, type RateSnapshot } from "./budget";

/**
 * Persisted GitHub rate budget per installation (InstallationRateLimit).
 * Reconcile and the live reads of the UI (run steps) both record the
 * `x-ratelimit-*` headers they saw, so either side can see what the other
 * spent before it calls GitHub.
 */

export async function persistRateBudget(
  installationId: bigint,
  budget: RateBudget,
  now: Date = new Date(),
): Promise<void> {
  for (const snap of budget.snapshots.values()) {
    const data = {
      limit: snap.limit,
      remaining: snap.remaining,
      resetAt: snap.resetAt,
      updatedAt: now,
    };
    await db.installationRateLimit.upsert({
      where: {
        installationId_resource: { installationId, resource: snap.resource },
      },
      create: { installationId, resource: snap.resource, ...data },
      update: data,
    });
  }
}

/** The stored core budget of an installation, if one was recorded. */
export async function storedCoreBudget(
  installationId: bigint,
): Promise<RateSnapshot | null> {
  return db.installationRateLimit.findUnique({
    where: { installationId_resource: { installationId, resource: "core" } },
    select: { resource: true, limit: true, remaining: true, resetAt: true },
  });
}

/**
 * True when interactive reads must not spend more of the installation's
 * budget: below the interactive floor until the window resets.
 */
export function belowInteractiveFloor(
  snap: RateSnapshot | null,
  now: number,
): boolean {
  if (!snap || snap.resetAt.getTime() <= now) return false;
  return snap.remaining < RateBudget.interactiveFloor(snap.limit);
}
