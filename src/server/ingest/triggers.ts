import "server-only";
import { getDeadline } from "@vercel/functions";
import { env } from "@/env";
import { db } from "@/server/db";
import { appOctokit, installationOctokit } from "@/server/github/app";
import { Deadline, LAZY_BUDGET_MS, SOFT_BUDGET_MS } from "./budget";
import type { GitHubApi, GitHubClients } from "./github-client";
import {
  claimInstallation,
  runReconcile,
  type ReconcileResult,
} from "./reconcile";

/**
 * The three ways reconcile is triggered (design §5.3 "Triggers"):
 * - the cron route (daily Vercel cron, Docker sidecar every 10 minutes),
 * - lazily when an installation page is opened and lastReconciledAt is older
 *   than LAZY_RECONCILE_MINUTES,
 * - Sync now (operator), at most once per 5 minutes per installation.
 * No Vercel beta feature is involved: lazy reconcile and Sync now run in
 * `after()` of the same request, with a 60 s budget.
 */

const SYNC_NOW_INTERVAL_MS = 5 * 60 * 1000;
const LAZY_LOCK_MS = 5 * 60 * 1000;

/** Production GitHub clients: the App JWT and the token broker. */
export const githubClients: GitHubClients = {
  app: () => appOctokit() as unknown as GitHubApi,
  installation: async (installationId, purpose, granted, repoIds) =>
    (await installationOctokit(
      installationId,
      purpose,
      granted,
      repoIds,
    )) as unknown as GitHubApi,
};

/** Deadline for the cron route: Vercel's deadline minus 30 s, else 240 s. */
export function cronDeadline(): Deadline {
  let platform: Date | undefined;
  try {
    platform = getDeadline();
  } catch {
    platform = undefined;
  }
  return Deadline.forRequest(platform, SOFT_BUDGET_MS);
}

function lazyDeadline(): Deadline {
  let platform: Date | undefined;
  try {
    platform = getDeadline();
  } catch {
    platform = undefined;
  }
  return Deadline.forRequest(platform, LAZY_BUDGET_MS);
}

export async function reconcileAll(
  deadline: Deadline = cronDeadline(),
): Promise<ReconcileResult> {
  return runReconcile({ deadline, clients: githubClients });
}

/**
 * Claims a lazy reconcile for an installation. Exactly one caller wins while
 * the installation is stale: the claim sets the reconcile lock in the same
 * UPDATE that checks staleness, so concurrent page views (in this process or
 * another instance) cannot both start one.
 */
export async function claimLazyReconcile(
  installationId: bigint,
  now: Date = new Date(),
  minutes: number = env.LAZY_RECONCILE_MINUTES,
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - minutes * 60_000);
  const { count } = await db.installation.updateMany({
    where: {
      id: installationId,
      deletedAt: null,
      suspendedAt: null,
      AND: [
        {
          OR: [
            { lastReconciledAt: null },
            { lastReconciledAt: { lt: staleBefore } },
          ],
        },
        {
          OR: [
            { reconcileLockedUntil: null },
            { reconcileLockedUntil: { lt: now } },
          ],
        },
      ],
    },
    data: { reconcileLockedUntil: new Date(now.getTime() + LAZY_LOCK_MS) },
  });
  return count === 1;
}

export type Scheduler = (task: () => Promise<unknown>) => void;

/**
 * Page-view trigger. Returns true when this call scheduled the reconcile.
 * `schedule` is Next's `after()` in pages; tests pass their own.
 */
export async function maybeLazyReconcile(
  installationId: bigint,
  schedule: Scheduler,
  opts: { clients?: GitHubClients; now?: Date; minutes?: number } = {},
): Promise<boolean> {
  if (!(await claimLazyReconcile(installationId, opts.now, opts.minutes)))
    return false;
  schedule(() =>
    runReconcile({
      deadline: lazyDeadline(),
      clients: opts.clients ?? githubClients,
      installationId,
      preclaimed: true,
    }).catch((error: unknown) => {
      console.error(
        "lazy reconcile failed",
        error instanceof Error ? error.message : "unknown",
      );
    }),
  );
  return true;
}

/**
 * Rate limit of Sync now: claims the 5-minute slot of an installation.
 * False when Sync now ran less than five minutes ago.
 */
export async function claimSyncNow(
  installationId: bigint,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await db.installation.updateMany({
    where: {
      id: installationId,
      deletedAt: null,
      suspendedAt: null,
      OR: [
        { syncRequestedAt: null },
        {
          syncRequestedAt: {
            lt: new Date(now.getTime() - SYNC_NOW_INTERVAL_MS),
          },
        },
      ],
    },
    data: { syncRequestedAt: now },
  });
  return count === 1;
}

/** Runs reconcile for one installation (Sync now); skipped while another reconcile holds the lock. */
export function scheduleInstallationReconcile(
  installationId: bigint,
  schedule: Scheduler,
  clients: GitHubClients = githubClients,
): void {
  schedule(async () => {
    const deadline = lazyDeadline();
    if (!(await claimInstallation(installationId, new Date(deadline.now()))))
      return;
    await runReconcile({
      deadline,
      clients,
      installationId,
      preclaimed: true,
    }).catch((error: unknown) => {
      console.error(
        "sync now failed",
        error instanceof Error ? error.message : "unknown",
      );
    });
  });
}
