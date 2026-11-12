import "server-only";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import { forgetPurgeDays } from "@/server/ingest/ignore-purge";
import { inScope, NotFoundError } from "./installations";

/**
 * Repository ignore state (UI overhaul §3): lookups and the local writes of
 * REPO_IGNORE / REPO_UNIGNORE. The management module
 * (src/server/management/repos.ts) runs them through the action pipeline;
 * every function takes a TenantScope and answers NotFoundError for an id of
 * another installation.
 */

export type IgnoreTarget = {
  id: bigint;
  fullName: string;
  fork: boolean;
  ignoredAt: Date | null;
};

/**
 * Repositories of a visible installation by id (removed ones included: an
 * ignored repo that left the selection can still be un-ignored). Any id that
 * is not the installation's makes the whole call NotFoundError.
 */
export async function findIgnoreTargets(
  scope: TenantScope,
  installationId: bigint,
  repositoryIds: readonly bigint[],
): Promise<IgnoreTarget[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const unique = [...new Set(repositoryIds)];
  if (unique.length === 0) return [];
  const rows = await db.repository.findMany({
    where: { id: { in: unique }, installationId },
    select: { id: true, fullName: true, fork: true, ignoredAt: true },
    orderBy: { fullName: "asc" },
  });
  if (rows.length !== unique.length) throw new NotFoundError();
  return rows;
}

/**
 * Marks one repository ignored: no more sync, backfill, runner sampling or
 * webhook folds from now on. Its sync state and dirty marks go in the same
 * transaction; the heavy purge of runs, jobs and stats is reconcile step j
 * (src/server/ingest/ignore-purge.ts). Returns false when it was already
 * ignored.
 */
export async function applyRepoIgnore(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  return db.$transaction(async (tx) => {
    const { count } = await tx.repository.updateMany({
      where: { id: repositoryId, installationId, ignoredAt: null },
      data: { ignoredAt: now, ignoredByUserId: userId, ignorePurgedAt: null },
    });
    if (count === 0) return false;
    await tx.syncState.deleteMany({ where: { repositoryId, installationId } });
    await tx.rollupDirty.deleteMany({
      where: { repositoryId, installationId },
    });
    return true;
  });
}

/**
 * Un-ignores one repository and schedules a fresh history import: the sync
 * state starts over (no cursor, backfill not done, full re-import), so the
 * next reconcile syncs it from now and backfills the retention window. The
 * imported runs mark their days dirty, and the drained days recompute the
 * runner stats with the repository again. Returns false when it was not
 * ignored.
 */
export async function applyRepoUnignore(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
): Promise<boolean> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const changed = await db.$transaction(async (tx) => {
    const { count } = await tx.repository.updateMany({
      where: { id: repositoryId, installationId, ignoredAt: { not: null } },
      data: { ignoredAt: null, ignoredByUserId: null, ignorePurgedAt: null },
    });
    if (count === 0) return false;
    const reset = {
      runsCursor: null,
      backfillUntil: null,
      backfillDone: false,
      runsEtag: null,
      needsResync: true,
      lastError: null,
    };
    await tx.syncState.upsert({
      where: { repositoryId },
      create: { repositoryId, installationId, ...reset },
      update: reset,
    });
    return true;
  });
  if (changed) await forgetPurgeDays(repositoryId);
  return changed;
}

export type IgnoredRepository = {
  repositoryId: string;
  fullName: string;
  fork: boolean;
  private: boolean;
  archived: boolean;
  /** Left the installation's repository selection. */
  removed: boolean;
  ignoredAt: string;
  /** Display name of the admin who ignored it, when the user still exists. */
  ignoredBy: string | null;
  /** False while reconcile is still deleting its stored data. */
  purged: boolean;
};

/** Ignored repositories of a visible installation (settings list, banners). */
export async function listIgnoredRepositories(
  scope: TenantScope,
  installationId: bigint,
): Promise<IgnoredRepository[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const rows = await db.repository.findMany({
    where: { installationId, ignoredAt: { not: null } },
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      fork: true,
      private: true,
      archived: true,
      removedAt: true,
      ignoredAt: true,
      ignoredByUserId: true,
      ignorePurgedAt: true,
    },
  });
  const userIds = [
    ...new Set(rows.map((r) => r.ignoredByUserId).filter((u) => u != null)),
  ];
  const users =
    userIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name || u.email]));
  return rows.map((r) => ({
    repositoryId: String(r.id),
    fullName: r.fullName,
    fork: r.fork,
    private: r.private,
    archived: r.archived,
    removed: r.removedAt != null,
    ignoredAt: r.ignoredAt!.toISOString(),
    ignoredBy: r.ignoredByUserId
      ? (nameOf.get(r.ignoredByUserId) ?? null)
      : null,
    purged: r.ignorePurgedAt != null,
  }));
}

export type RepoCounts = {
  /** Active repositories (in the selection, not ignored). */
  active: number;
  ignored: number;
  forks: number;
};

/** Repository counts of a visible installation (page subtitles). */
export async function countRepositories(
  scope: TenantScope,
  installationId: bigint,
): Promise<RepoCounts> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const [active, ignored, forks] = await Promise.all([
    db.repository.count({
      where: { installationId, removedAt: null, ignoredAt: null },
    }),
    db.repository.count({
      where: { installationId, removedAt: null, ignoredAt: { not: null } },
    }),
    db.repository.count({
      where: { installationId, removedAt: null, fork: true },
    }),
  ]);
  return { active, ignored, forks };
}

export type IgnorableRepository = {
  id: string;
  fullName: string;
  fork: boolean;
  private: boolean;
  archived: boolean;
};

/** Active (not ignored) repositories of a visible installation, for the ignore list. */
export async function listIgnorableRepositories(
  scope: TenantScope,
  installationId: bigint,
): Promise<IgnorableRepository[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const rows = await db.repository.findMany({
    where: { installationId, removedAt: null, ignoredAt: null },
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      fork: true,
      private: true,
      archived: true,
    },
  });
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}
