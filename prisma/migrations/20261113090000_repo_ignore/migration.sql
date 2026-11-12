-- Repo ignore (UI overhaul): an admin can ignore a repository. Ignored repos
-- get no sync, backfill, runner sampling or webhook folds, and a reconcile
-- step purges their stored runs, jobs and rollups. `fork` comes from the
-- inventory. Open PR and alert counts are cached per repository.

ALTER TYPE "AuditAction" ADD VALUE 'REPO_IGNORE';
ALTER TYPE "AuditAction" ADD VALUE 'REPO_UNIGNORE';

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "countsRefreshedAt" TIMESTAMPTZ(3),
ADD COLUMN     "fork" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ignorePurgedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ignoredAt" TIMESTAMPTZ(3),
ADD COLUMN     "ignoredByUserId" TEXT,
ADD COLUMN     "openAlertCount" INTEGER,
ADD COLUMN     "openAlertHighCount" INTEGER,
ADD COLUMN     "openPrCount" INTEGER;

-- CreateIndex
CREATE INDEX "Repository_installationId_ignoredAt_idx" ON "Repository"("installationId", "ignoredAt");
