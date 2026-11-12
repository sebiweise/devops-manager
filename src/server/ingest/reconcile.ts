import "server-only";
import { revalidateTag } from "next/cache";
import { env } from "@/env";
import { isAllowedAccount } from "@/server/authz/config";
import { db } from "@/server/db";
import { PermissionNotGrantedError } from "@/server/github/purposes";
import {
  DeadlineReached,
  RateBudget,
  RateLimited,
  type Deadline,
} from "./budget";
import {
  repairHookDeliveries,
  replayDeliveries,
  type HookLogResult,
  type ReplayResult,
} from "./deliveries";
import { withBudget, withDeadline, type GitHubClients } from "./github-client";
import { redactError } from "./webhook";
import {
  effectiveRetentionDays,
  PRUNE_INTERVAL_MS,
  SAMPLE_RETENTION_DAYS,
  pruneGlobal,
  pruneInstallation,
} from "./prune";
import { syncBilling, type BillingResult } from "./billing";
import { persistRateBudget } from "./rate-store";
import { drainRollups, markRecentDaysDirty } from "./rollup";
import { rollupRunnerDays } from "./runner-rollup";
import { sampleRunners, type RunnerSampleResult } from "./runners";
import { localDay } from "@/server/metrics/days";
import {
  backfill,
  incrementalSync,
  newStats,
  repairStale,
  type SyncContext,
  type SyncRepo,
  type SyncStats,
} from "./sync";

/**
 * Reconcile (design §5.3): one idempotent, deadline-aware pass that repairs
 * every gap webhooks may leave. Called by the daily Vercel cron and the Docker
 * cron sidecar (all installations), by lazy reconcile on page views and by
 * Sync now (one installation, 60 s budget).
 *
 * Steps, each bounded and cursor-persisted:
 *   a) replay local delivery failures      b) GitHub delivery log (cron only)
 *   c) stale jobs and runs                  d) incremental sync per repo
 *   e) backfill BACKFILL_DAYS               f) runner sampling (+ daily discovery)
 *   g) rollups (incl. DailyRunnerStat)      h) billing (daily)   i) prune (daily)
 *
 * Installations are processed round-robin by lastReconciledAt and claimed
 * with a column lock (`reconcileLockedUntil`), which is PgBouncer-safe.
 */

const LOCK_MS = 5 * 60 * 1000;

export type InstallationResult = {
  installationId: string;
  status: "ok" | "partial" | "skipped" | "error";
  reason?: string;
  stats: SyncStats;
  rollups: number;
  backfillDone: number;
  repos: number;
  runners?: RunnerSampleResult;
  billing?: BillingResult;
};

export type ReconcileResult = {
  replay?: ReplayResult;
  hookLog?: HookLogResult;
  installations: InstallationResult[];
  deadlineReached: boolean;
};

export type ReconcileOptions = {
  deadline: Deadline;
  clients: GitHubClients;
  /** Only this installation (lazy reconcile, Sync now). */
  installationId?: bigint;
  /** The caller already holds the installation's lock (lazy reconcile). */
  preclaimed?: boolean;
  /** Overrides for tests; default from env. */
  config?: Partial<ReconcileConfig>;
};

export type ReconcileConfig = {
  backfillDays: number;
  maxRetentionDays: number;
  lean: boolean;
  /** Target runner sample interval (the Docker cron interval). */
  sampleIntervalS: number;
};

function configFromEnv(): ReconcileConfig {
  return {
    backfillDays: env.BACKFILL_DAYS,
    maxRetentionDays: env.MAX_RETENTION_DAYS,
    lean: env.LEAN_WEBHOOKS,
    sampleIntervalS: env.CRON_INTERVAL_SECONDS,
  };
}

/** Claims an installation for reconcile; false when another worker holds it. */
export async function claimInstallation(
  installationId: bigint,
  now: Date,
): Promise<boolean> {
  const { count } = await db.installation.updateMany({
    where: {
      id: installationId,
      OR: [
        { reconcileLockedUntil: null },
        { reconcileLockedUntil: { lt: now } },
      ],
    },
    data: { reconcileLockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  return count === 1;
}

async function releaseInstallation(
  installationId: bigint,
  now: Date,
  outcome?: InstallationResult,
) {
  await db.installation.updateMany({
    where: { id: installationId },
    data: {
      reconcileLockedUntil: null,
      lastReconciledAt: now,
      lastReconcileStatus: outcome?.status ?? "error",
      lastReconcileReason: outcome
        ? (outcome.reason ?? null)
        : "reconcile aborted",
    },
  });
}

type InstallationRow = {
  id: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  billingSyncedAt: Date | null;
  permissions: unknown;
  timezone: string;
  rawRetentionDays: number;
  lastPrunedAt: Date | null;
};

async function reconcileInstallation(
  inst: InstallationRow,
  opts: ReconcileOptions,
  config: ReconcileConfig,
): Promise<InstallationResult> {
  const { deadline } = opts;
  const stats = newStats();
  const result: InstallationResult = {
    installationId: String(inst.id),
    status: "ok",
    stats,
    rollups: 0,
    backfillDone: 0,
    repos: 0,
  };
  const startedMs = deadline.now();
  const budget = new RateBudget(() => deadline.now());
  const retention = effectiveRetentionDays(
    inst.rawRetentionDays,
    config.maxRetentionDays,
  );

  const repos = await db.repository.findMany({
    where: { installationId: inst.id, removedAt: null },
    select: {
      id: true,
      ownerLogin: true,
      name: true,
      fullName: true,
      defaultBranch: true,
    },
  });
  // Repos that waited longest go first, so a deadline rotates through them.
  const states = await db.syncState.findMany({
    where: { installationId: inst.id },
    select: { repositoryId: true, updatedAt: true },
  });
  const touched = new Map(
    states.map((s) => [s.repositoryId, s.updatedAt.getTime()]),
  );
  const ordered: SyncRepo[] = [...repos].sort(
    (a, b) => (touched.get(a.id) ?? 0) - (touched.get(b.id) ?? 0),
  );
  result.repos = ordered.length;

  try {
    // a) Local replay for this installation (the cron pass replays all first).
    if (opts.installationId !== undefined)
      await replayDeliveries(deadline, inst.id);

    let ctx: SyncContext | null = null;
    try {
      const api = await opts.clients.installation(
        inst.id,
        "sync.runs",
        (inst.permissions ?? {}) as Record<string, unknown>,
      );
      ctx = {
        installationId: inst.id,
        api: withBudget(api, budget, deadline),
        budget,
        deadline,
        lean: config.lean,
        backfillDays: Math.min(
          config.backfillDays,
          retention ?? config.backfillDays,
        ),
        stats,
      };
    } catch (error) {
      if (!(error instanceof PermissionNotGrantedError)) throw error;
      result.status = "skipped";
      result.reason = redactError(error.message);
    }

    if (ctx) {
      // c) Stale state (uses the reserve budget). A failure here must not
      // skip d) and e).
      try {
        await repairStale(ctx);
      } catch (error) {
        if (error instanceof DeadlineReached || error instanceof RateLimited)
          throw error;
        console.warn(
          "stale repair failed",
          redactError(error instanceof Error ? error.message : String(error)),
        );
      }
      // d) Incremental sync, then e) backfill, per repo.
      for (const repo of ordered) {
        try {
          await incrementalSync(ctx, repo);
        } catch (error) {
          if (error instanceof DeadlineReached || error instanceof RateLimited)
            throw error;
          await recordRepoError(repo.id, error);
        }
      }
      for (const repo of ordered) {
        try {
          if (await backfill(ctx, repo)) result.backfillDone++;
        } catch (error) {
          if (error instanceof DeadlineReached || error instanceof RateLimited)
            throw error;
          await recordRepoError(repo.id, error);
        }
      }
    }
  } catch (error) {
    if (error instanceof DeadlineReached || error instanceof RateLimited) {
      result.status = "partial";
      result.reason =
        error instanceof RateLimited
          ? "rate budget paused"
          : `deadline (${Math.max(0, Math.round((deadline.endsAt - startedMs) / 1000))} s budget)`;
    } else {
      result.status = "error";
      result.reason = redactError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const permissions = (inst.permissions ?? {}) as Record<string, unknown>;
  // f) Runner sampling. Skipped after a deadline or rate stop above; a
  // missing permission only means there is nothing to sample.
  if (result.status === "ok" || result.status === "skipped") {
    try {
      const api = await opts.clients.installation(
        inst.id,
        "sync.runners",
        permissions,
      );
      result.runners = await sampleRunners({
        installationId: inst.id,
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        permissions,
        api: withBudget(api, budget, deadline),
        budget,
        deadline,
        targetIntervalS: config.sampleIntervalS,
      });
    } catch (error) {
      if (error instanceof DeadlineReached || error instanceof RateLimited) {
        result.status = "partial";
        result.reason =
          error instanceof RateLimited ? "rate budget paused" : "deadline";
      } else if (!(error instanceof PermissionNotGrantedError)) {
        console.warn(
          "runner sampling failed",
          redactError(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  // h) Billing, once a day (its own token or credential, not the sync budget).
  if (!deadline.expired(10_000)) {
    try {
      result.billing = await syncBilling(
        {
          id: inst.id,
          accountLogin: inst.accountLogin,
          accountType: inst.accountType,
          permissions,
          billingSyncedAt: inst.billingSyncedAt,
        },
        opts.clients,
        deadline,
      );
    } catch (error) {
      if (!(error instanceof DeadlineReached || error instanceof RateLimited)) {
        console.warn(
          "billing sync failed",
          redactError(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  // g) Rollups, also after a partial pass: what was ingested is counted.
  try {
    await markRecentDaysDirty(inst.id, inst.timezone);
    const drained = await drainRollups(
      inst.id,
      inst.timezone,
      deadline,
      retention,
    );
    result.rollups = drained.partitions;
    if (drained.remaining && result.status === "ok") result.status = "partial";
    // DailyRunnerStat per installation-day: recomputed days plus today and
    // yesterday, which new runner samples change without any job event.
    // Days past the sample retention keep their stats (onlineS needs samples).
    const today = new Date(deadline.now());
    const oldest = localDay(
      new Date(today.getTime() - (SAMPLE_RETENTION_DAYS - 1) * 86_400_000),
      inst.timezone,
    );
    await rollupRunnerDays(
      inst.id,
      [
        ...drained.days,
        localDay(today, inst.timezone),
        localDay(new Date(today.getTime() - 86_400_000), inst.timezone),
      ].filter((d) => d >= oldest),
      inst.timezone,
      deadline,
    );
  } catch (error) {
    result.status = "error";
    result.reason = redactError(
      error instanceof Error ? error.message : String(error),
    );
  }

  // i) Prune, once a day.
  const now = deadline.now();
  if (
    !deadline.expired() &&
    (!inst.lastPrunedAt ||
      now - inst.lastPrunedAt.getTime() >= PRUNE_INTERVAL_MS)
  ) {
    await pruneInstallation(inst.id, retention, deadline);
    if (!deadline.expired()) {
      await db.installation.updateMany({
        where: { id: inst.id },
        data: { lastPrunedAt: new Date(now) },
      });
    }
  }

  await persistRateBudget(inst.id, budget);
  return result;
}

async function recordRepoError(repositoryId: bigint, error: unknown) {
  await db.syncState.updateMany({
    where: { repositoryId },
    data: {
      lastError: redactError(
        error instanceof Error ? error.message : String(error),
      ),
    },
  });
}

/** Runs reconcile within `opts.deadline`. */
export async function runReconcile(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const config = { ...configFromEnv(), ...opts.config };
  const { deadline } = opts;
  const result: ReconcileResult = { installations: [], deadlineReached: false };

  if (opts.installationId === undefined) {
    // Instance-wide steps: a) all local failures, b) GitHub's delivery log.
    result.replay = await replayDeliveries(deadline);
    try {
      result.hookLog = await repairHookDeliveries(
        withDeadline(opts.clients.app(), deadline),
        deadline,
      );
    } catch (error) {
      console.warn(
        "hook delivery log unavailable",
        redactError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  const installations = (
    await db.installation.findMany({
      where: {
        deletedAt: null,
        suspendedAt: null,
        ...(opts.installationId !== undefined
          ? { id: opts.installationId }
          : {}),
      },
      orderBy: [{ lastReconciledAt: { sort: "asc", nulls: "first" } }],
      select: {
        id: true,
        accountLogin: true,
        accountType: true,
        billingSyncedAt: true,
        permissions: true,
        timezone: true,
        rawRetentionDays: true,
        lastPrunedAt: true,
      },
    })
  ).filter((i) => isAllowedAccount(i.accountLogin));

  for (const inst of installations) {
    if (deadline.expired(10_000)) {
      result.deadlineReached = true;
      break;
    }
    const startedAt = new Date(deadline.now());
    if (!opts.preclaimed && !(await claimInstallation(inst.id, startedAt))) {
      result.installations.push({
        installationId: String(inst.id),
        status: "skipped",
        reason: "locked by another reconcile",
        stats: newStats(),
        rollups: 0,
        backfillDone: 0,
        repos: 0,
      });
      continue;
    }
    let outcome: InstallationResult | undefined;
    try {
      outcome = await reconcileInstallation(inst, opts, config);
      result.installations.push(outcome);
      if (outcome.status !== "ok")
        console.warn(
          "reconcile installation not ok",
          String(inst.id),
          outcome.status,
          outcome.reason ?? "",
        );
    } finally {
      await releaseInstallation(inst.id, new Date(deadline.now()), outcome);
      try {
        revalidateTag(`inst:${inst.id}`, "max");
      } catch {
        // Outside a request context (tests, scripts) there is no cache to revalidate.
      }
    }
  }

  if (opts.installationId === undefined && !deadline.expired()) {
    await pruneGlobal(deadline);
  }
  result.deadlineReached ||= deadline.expired();
  return result;
}
