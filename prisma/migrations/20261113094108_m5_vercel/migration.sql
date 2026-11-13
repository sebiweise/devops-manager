-- CreateEnum
CREATE TYPE "VercelTokenSource" AS ENUM ('DB', 'ENV');

-- CreateEnum
CREATE TYPE "VercelDeploymentState" AS ENUM ('QUEUED', 'INITIALIZING', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'BLOCKED', 'DELETED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('DEPENDABOT', 'CODE_SCANNING', 'SECRET_SCANNING', 'COMPLIANCE', 'HYGIENE', 'RUNNER', 'UPTIME', 'VERCEL', 'CREDENTIAL');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'DISMISSED', 'FIXED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_CONNECT';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_TOKEN_ROTATE';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_DISCONNECT';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_PROJECT_LINK';

-- CreateTable
CREATE TABLE "VercelConnection" (
    "installationId" BIGINT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamSlug" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "plan" TEXT,
    "tokenSource" "VercelTokenSource" NOT NULL,
    "accessToken" TEXT,
    "tokenHint" TEXT,
    "tokenScope" TEXT,
    "tokenExpiresAt" TIMESTAMPTZ(3),
    "managementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "lastSyncStatus" TEXT,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "projectsSyncedAt" TIMESTAMPTZ(3),
    "pausedUntil" TIMESTAMPTZ(3),
    "deploymentsCursor" BIGINT,
    "deploymentsPageNext" BIGINT,
    "deploymentsPassTop" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VercelConnection_pkey" PRIMARY KEY ("installationId")
);

-- CreateTable
CREATE TABLE "VercelProject" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "framework" TEXT,
    "linkType" TEXT,
    "linkRepoId" BIGINT,
    "linkRepo" TEXT,
    "productionBranch" TEXT,
    "repositoryId" BIGINT,
    "manualRepositoryId" BIGINT,
    "latestProdDeploymentId" TEXT,
    "latestProdState" TEXT,
    "latestProdReadyAt" TIMESTAMPTZ(3),
    "liveProdDeploymentId" TEXT,
    "autoAssignPausedAt" TIMESTAMPTZ(3),
    "dirtyAt" TIMESTAMPTZ(3),
    "hintRefreshedAt" TIMESTAMPTZ(3),
    "pausedAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VercelProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VercelDeployment" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "projectId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "state" "VercelDeploymentState" NOT NULL,
    "readySubstate" TEXT,
    "url" TEXT,
    "branch" TEXT,
    "commitSha" TEXT,
    "commitMessage" TEXT,
    "creatorKind" TEXT,
    "errorCode" TEXT,
    "isRollbackCandidate" BOOLEAN NOT NULL DEFAULT false,
    "auditLogId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "buildingAt" TIMESTAMPTZ(3),
    "readyAt" TIMESTAMPTZ(3),
    "buildMs" INTEGER,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VercelDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyDeploymentStat" (
    "installationId" BIGINT NOT NULL,
    "projectId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "target" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "ready" INTEGER NOT NULL,
    "error" INTEGER NOT NULL,
    "canceled" INTEGER NOT NULL,
    "buildMsP50" INTEGER,
    "buildMsP90" INTEGER,

    CONSTRAINT "DailyDeploymentStat_pkey" PRIMARY KEY ("installationId","projectId","day","target")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT,
    "source" "FindingSource" NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "status" "FindingStatus" NOT NULL,
    "title" TEXT NOT NULL,
    "externalUrl" TEXT,
    "details" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureAvailability" (
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "feature" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FeatureAvailability_pkey" PRIMARY KEY ("installationId","repositoryId","feature")
);

-- CreateIndex
CREATE UNIQUE INDEX "VercelConnection_teamId_key" ON "VercelConnection"("teamId");

-- CreateIndex
CREATE INDEX "VercelProject_installationId_removedAt_idx" ON "VercelProject"("installationId", "removedAt");

-- CreateIndex
CREATE INDEX "VercelProject_installationId_repositoryId_idx" ON "VercelProject"("installationId", "repositoryId");

-- CreateIndex
CREATE INDEX "VercelProject_installationId_manualRepositoryId_idx" ON "VercelProject"("installationId", "manualRepositoryId");

-- CreateIndex
CREATE INDEX "VercelProject_installationId_dirtyAt_idx" ON "VercelProject"("installationId", "dirtyAt");

-- CreateIndex
CREATE INDEX "VercelDeployment_installationId_createdAt_idx" ON "VercelDeployment"("installationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VercelDeployment_installationId_projectId_createdAt_idx" ON "VercelDeployment"("installationId", "projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VercelDeployment_installationId_commitSha_idx" ON "VercelDeployment"("installationId", "commitSha");

-- CreateIndex
CREATE INDEX "VercelDeployment_installationId_state_idx" ON "VercelDeployment"("installationId", "state");

-- CreateIndex
CREATE INDEX "DailyDeploymentStat_installationId_day_idx" ON "DailyDeploymentStat"("installationId", "day");

-- CreateIndex
CREATE INDEX "Finding_installationId_status_severity_idx" ON "Finding"("installationId", "status", "severity");

-- CreateIndex
CREATE INDEX "Finding_installationId_repositoryId_status_idx" ON "Finding"("installationId", "repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_installationId_source_repositoryId_ruleKey_key" ON "Finding"("installationId", "source", "repositoryId", "ruleKey");

-- AddForeignKey
ALTER TABLE "VercelConnection" ADD CONSTRAINT "VercelConnection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VercelProject" ADD CONSTRAINT "VercelProject_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "VercelConnection"("installationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VercelProject" ADD CONSTRAINT "VercelProject_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VercelDeployment" ADD CONSTRAINT "VercelDeployment_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "VercelConnection"("installationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VercelDeployment" ADD CONSTRAINT "VercelDeployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VercelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
