import { Prisma } from "@/generated/prisma/client";

/**
 * The one definition of "a repository data is loaded for": in the
 * installation's selection (`removedAt` null) and not ignored by an admin
 * (`ignoredAt` null). Reconcile, backfill, runner sampling, the webhook fold
 * and the readers in src/server/data all use it, so an ignored repository
 * cannot come back through a side door.
 */
export const activeRepoWhere = { removedAt: null, ignoredAt: null } as const;

/** Not ignored (removed repos still count, e.g. for history reads). */
export const notIgnoredWhere = { ignoredAt: null } as const;

/**
 * SQL guard for raw queries over tenant tables keyed by `repositoryId`:
 * `AND <alias>."repositoryId"` is not an ignored repository. The lookup is a
 * primary-key probe, so it stays cheap inside large scans.
 */
export function notIgnoredRepo(alias: string): Prisma.Sql {
  if (!/^[a-z]\w*$/i.test(alias)) throw new Error("invalid alias");
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "Repository" ign
    WHERE ign."id" = ${Prisma.raw(`${alias}."repositoryId"`)} AND ign."ignoredAt" IS NOT NULL)`;
}
