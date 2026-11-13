import "server-only";
import { describeError } from "@/lib/describe-error";
import { getDeadline } from "@vercel/functions";
import { env } from "@/env";
import { db } from "@/server/db";
import { appOctokit, installationOctokit, Octokit } from "@/server/github/app";
import { PermissionNotGrantedError } from "@/server/github/purposes";
import { Deadline, LAZY_BUDGET_MS, RateBudget, SOFT_BUDGET_MS } from "./budget";
import {
  withBudget,
  type GitHubApi,
  type GitHubClients,
} from "./github-client";
import { persistRateBudget } from "./rate-store";
import { claimLazyRunnerSample, sampleRunners } from "./runners";
import { effectiveRetentionDays } from "./prune";
import { runVercelStep } from "./vercel-reconcile";
import type { Fetch } from "@/server/vercel/client";
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
/** After a pass that stopped early (deadline or rate pause), the next page view may continue sooner. */
const LAZY_CONTINUE_MS = 60 * 1000;

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
  user: (token) => new Octokit({ auth: token }) as unknown as GitHubApi,
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
            // An unfinished pass (backfill, deadline) continues after a minute.
            {
              lastReconcileStatus: "partial",
              lastReconciledAt: {
                lt: new Date(now.getTime() - LAZY_CONTINUE_MS),
              },
            },
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

/**
 * Runs reconcile for one installation (Sync now, first sync after a Vercel
 * connect); skipped while another reconcile holds the lock. Sync now also
 * re-reads the Vercel project list.
 */
export function scheduleInstallationReconcile(
  installationId: bigint,
  schedule: Scheduler,
  clients: GitHubClients = githubClients,
  opts: { forceVercelProjects?: boolean } = {},
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
      vercel: { forceProjects: opts.forceVercelProjects },
    }).catch((error: unknown) => {
      console.error(
        "sync now failed",
        error instanceof Error ? error.message : "unknown",
      );
    });
  });
}

/**
 * Lazy runner sample for /runners and /queue views (design §5.3 f): at most
 * once per two minutes per installation, in `after()` of the page request.
 * Returns true when this call scheduled the sample.
 */
export async function maybeLazyRunnerSample(
  installationId: bigint,
  schedule: Scheduler,
  opts: { clients?: GitHubClients; now?: Date } = {},
): Promise<boolean> {
  if (!(await claimLazyRunnerSample(installationId, opts.now))) return false;
  const clients = opts.clients ?? githubClients;
  schedule(async () => {
    try {
      const inst = await db.installation.findUnique({
        where: { id: installationId },
        select: { accountLogin: true, accountType: true, permissions: true },
      });
      if (!inst) return;
      const permissions = (inst.permissions ?? {}) as Record<string, unknown>;
      const deadline = lazyDeadline();
      const budget = new RateBudget(() => deadline.now());
      const api = await clients.installation(
        installationId,
        "sync.runners",
        permissions,
      );
      await sampleRunners(
        {
          installationId,
          accountLogin: inst.accountLogin,
          accountType: inst.accountType,
          permissions,
          api: withBudget(api, budget, deadline),
          budget,
          deadline,
          targetIntervalS: env.CRON_INTERVAL_SECONDS,
        },
        false,
      );
      await persistRateBudget(installationId, budget);
    } catch (error) {
      if (error instanceof PermissionNotGrantedError) return;
      console.warn("lazy runner sample failed", describeError(error));
    }
  });
  return true;
}

// ---------- Vercel (design addendum §7.2, §7.3) ----------

const VERCEL_LAZY_MS = 5 * 60 * 1000;
const VERCEL_LAZY_LOCK_MS = 60 * 1000;

/**
 * Claims the Vercel fast path of a page view: the connection was last synced
 * more than 5 minutes ago, it is not revoked or paused, and no reconcile
 * holds the installation's lock. The same column lock as reconcile, so a
 * lazy pass and a full pass never overlap.
 */
export async function claimLazyVercel(
  installationId: bigint,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await db.installation.updateMany({
    where: {
      id: installationId,
      deletedAt: null,
      suspendedAt: null,
      OR: [
        { reconcileLockedUntil: null },
        { reconcileLockedUntil: { lt: now } },
      ],
      vercel: {
        is: {
          revokedAt: null,
          AND: [
            {
              OR: [
                { lastSyncedAt: null },
                {
                  lastSyncedAt: {
                    lt: new Date(now.getTime() - VERCEL_LAZY_MS),
                  },
                },
              ],
            },
            { OR: [{ pausedUntil: null }, { pausedUntil: { lt: now } }] },
          ],
        },
      },
    },
    data: {
      reconcileLockedUntil: new Date(now.getTime() + VERCEL_LAZY_LOCK_MS),
    },
  });
  return count === 1;
}

/**
 * Page-view trigger of the Vercel fast path (v2 to v5, 20 s) in `after()`.
 * Called when the GitHub lazy reconcile did not start (that one includes
 * step v anyway). Returns true when this call scheduled it.
 */
export async function maybeLazyVercelRefresh(
  installationId: bigint,
  schedule: Scheduler,
  opts: { now?: Date; fetch?: Fetch } = {},
): Promise<boolean> {
  if (!(await claimLazyVercel(installationId, opts.now))) return false;
  schedule(async () => {
    try {
      const inst = await db.installation.findUnique({
        where: { id: installationId },
        select: { timezone: true, rawRetentionDays: true },
      });
      if (!inst) return;
      await runVercelStep({
        installationId,
        timezone: inst.timezone,
        retentionDays: effectiveRetentionDays(
          inst.rawRetentionDays,
          env.MAX_RETENTION_DAYS,
        ),
        deadline: lazyDeadline(),
        mode: "fast",
        fetch: opts.fetch,
      });
    } catch (error) {
      console.warn("lazy Vercel refresh failed", describeError(error));
    } finally {
      await db.installation
        .updateMany({
          where: { id: installationId },
          data: { reconcileLockedUntil: null },
        })
        .catch(() => undefined);
    }
  });
  return true;
}
