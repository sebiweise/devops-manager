-- CreateEnum
CREATE TYPE "AzureAuthKind" AS ENUM ('PAT', 'ENV', 'ENTRA_SP');

-- CreateEnum
CREATE TYPE "AzureBuildStatus" AS ENUM ('NOT_STARTED', 'POSTPONED', 'IN_PROGRESS', 'CANCELLING', 'COMPLETED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AzureBuildResult" AS ENUM ('SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'CANCELED', 'NONE');

-- CreateEnum
CREATE TYPE "AzureJobResult" AS ENUM ('SUCCEEDED', 'SUCCEEDED_WITH_ISSUES', 'FAILED', 'CANCELED', 'SKIPPED', 'ABANDONED', 'NONE');

-- CreateEnum
CREATE TYPE "AzureOs" AS ENUM ('LINUX', 'WINDOWS', 'MACOS', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'ADO_CONNECT';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_TOKEN_ROTATE';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_DISCONNECT';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_PROJECTS_SELECT';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_DEFINITION_LINK';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_DEFINITION_OS_SET';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_LIMITS_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_HOOKS_INSTALL';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_HOOK_SECRET_ROTATE';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_MANAGEMENT_TOGGLE';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_QUEUE_RUN';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_CANCEL';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_RETRY';
ALTER TYPE "AuditAction" ADD VALUE 'ADO_STAGE_RETRY';

-- AlterEnum
ALTER TYPE "FindingSource" ADD VALUE 'AZURE_PIPELINES';

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'github';

-- CreateTable
CREATE TABLE "AzureDevOpsConnection" (
    "installationId" BIGINT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "authKind" "AzureAuthKind" NOT NULL,
    "accessToken" TEXT,
    "tokenHint" TEXT,
    "tokenExpiresAt" TIMESTAMPTZ(3),
    "tenantId" TEXT,
    "clientId" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '{}',
    "managementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "hookKey" TEXT,
    "hookSecret" TEXT,
    "hookSecretPrev" TEXT,
    "hookSecretPrevUntil" TIMESTAMPTZ(3),
    "hookFailures" INTEGER NOT NULL DEFAULT 0,
    "hookFailuresSince" TIMESTAMPTZ(3),
    "hookBlockedUntil" TIMESTAMPTZ(3),
    "checkAppSlug" TEXT NOT NULL DEFAULT 'azure-pipelines',
    "hostedParallelJobs" INTEGER NOT NULL DEFAULT 1,
    "includedMinutes" INTEGER DEFAULT 1800,
    "maxJobMinutes" INTEGER NOT NULL DEFAULT 60,
    "monthResetDay" INTEGER NOT NULL DEFAULT 1,
    "blockWhenQuotaExhausted" BOOLEAN NOT NULL DEFAULT false,
    "detectedLimits" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "pausedUntil" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "lastSyncStatus" TEXT,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "definitionsSyncedAt" TIMESTAMPTZ(3),
    "poolsSampledAt" TIMESTAMPTZ(3),
    "usageSyncedAt" TIMESTAMPTZ(3),
    "hooksCheckedAt" TIMESTAMPTZ(3),
    "sweepAt" TIMESTAMPTZ(3),
    "jobRequestsAvailable" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzureDevOpsConnection_pkey" PRIMARY KEY ("installationId")
);

-- CreateTable
CREATE TABLE "AzureDevOpsProject" (
    "installationId" BIGINT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "buildsCursor" TIMESTAMPTZ(3),
    "buildsContinuation" TEXT,
    "buildsPassTop" TIMESTAMPTZ(3),
    "backfillBefore" TIMESTAMPTZ(3),
    "backfillDone" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzureDevOpsProject_pkey" PRIMARY KEY ("installationId","id")
);

-- CreateTable
CREATE TABLE "AzurePipelineDefinition" (
    "installationId" BIGINT NOT NULL,
    "projectId" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT,
    "yamlPath" TEXT,
    "repoType" TEXT NOT NULL,
    "linkRepoFullName" TEXT,
    "repositoryId" BIGINT,
    "manualRepositoryId" BIGINT,
    "defaultBranch" TEXT,
    "queueStatus" TEXT,
    "osOverride" "AzureOs",
    "dirtyAt" TIMESTAMPTZ(3),
    "hintRefreshedAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzurePipelineDefinition_pkey" PRIMARY KEY ("installationId","projectId","id")
);

-- CreateTable
CREATE TABLE "AzureBuild" (
    "installationId" BIGINT NOT NULL,
    "id" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "repositoryId" BIGINT,
    "buildNumber" TEXT NOT NULL,
    "status" "AzureBuildStatus" NOT NULL,
    "result" "AzureBuildResult" NOT NULL,
    "reason" TEXT NOT NULL,
    "headBranch" TEXT,
    "headSha" TEXT,
    "prNumber" INTEGER,
    "isDefaultBranch" BOOLEAN NOT NULL DEFAULT false,
    "queuedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "durationS" INTEGER,
    "queueS" INTEGER,
    "queuePosition" INTEGER,
    "maxAttempt" INTEGER NOT NULL DEFAULT 1,
    "firstAttemptResult" "AzureBuildResult",
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "lastChangedAt" TIMESTAMPTZ(3),
    "timelineSyncedAt" TIMESTAMPTZ(3),
    "timelineChangeId" INTEGER,
    "dirtyAt" TIMESTAMPTZ(3),
    "hintRefreshedAt" TIMESTAMPTZ(3),
    "auditLogId" TEXT,
    "auditLinkKind" TEXT,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzureBuild_pkey" PRIMARY KEY ("installationId","id")
);

-- CreateTable
CREATE TABLE "AzureBuildJob" (
    "installationId" BIGINT NOT NULL,
    "buildId" INTEGER NOT NULL,
    "recordId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" BIGINT,
    "identifier" TEXT,
    "stageIdentifier" TEXT,
    "name" TEXT NOT NULL,
    "baseName" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "result" "AzureJobResult" NOT NULL,
    "poolId" INTEGER,
    "isHosted" BOOLEAN,
    "hostedImage" TEXT,
    "os" "AzureOs" NOT NULL DEFAULT 'UNKNOWN',
    "workerName" TEXT,
    "logId" INTEGER,
    "queuedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "durationS" INTEGER,
    "queueS" INTEGER,
    "hitJobCap" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AzureBuildJob_pkey" PRIMARY KEY ("installationId","buildId","recordId","attempt")
);

-- CreateTable
CREATE TABLE "AzurePool" (
    "installationId" BIGINT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "isHosted" BOOLEAN NOT NULL,
    "poolType" TEXT NOT NULL,
    "size" INTEGER,
    "sampledAt" TIMESTAMPTZ(3) NOT NULL,
    "removedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AzurePool_pkey" PRIMARY KEY ("installationId","id")
);

-- CreateTable
CREATE TABLE "AzureAgent" (
    "installationId" BIGINT NOT NULL,
    "poolId" INTEGER NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "version" TEXT,
    "osDescription" TEXT,
    "busy" BOOLEAN NOT NULL,
    "statusChangedAt" TIMESTAMPTZ(3),
    "sampledAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzureAgent_pkey" PRIMARY KEY ("installationId","poolId","id")
);

-- CreateTable
CREATE TABLE "AzurePoolSample" (
    "installationId" BIGINT NOT NULL,
    "poolId" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "running" INTEGER NOT NULL,
    "queued" INTEGER NOT NULL,
    "onlineAgents" INTEGER,

    CONSTRAINT "AzurePoolSample_pkey" PRIMARY KEY ("installationId","poolId","at")
);

-- CreateTable
CREATE TABLE "AzureJobRequest" (
    "installationId" BIGINT NOT NULL,
    "poolId" INTEGER NOT NULL,
    "requestId" BIGINT NOT NULL,
    "projectId" TEXT,
    "isHosted" BOOLEAN NOT NULL,
    "isPrivate" BOOLEAN,
    "os" "AzureOs" NOT NULL DEFAULT 'UNKNOWN',
    "hostedImage" TEXT,
    "queueTime" TIMESTAMPTZ(3) NOT NULL,
    "assignTime" TIMESTAMPTZ(3),
    "finishTime" TIMESTAMPTZ(3),
    "jobId" TEXT,
    "buildId" INTEGER,
    "result" TEXT,

    CONSTRAINT "AzureJobRequest_pkey" PRIMARY KEY ("installationId","requestId")
);

-- CreateTable
CREATE TABLE "DailyAzureUsage" (
    "installationId" BIGINT NOT NULL,
    "day" DATE NOT NULL,
    "hostedMinutesPrivate" INTEGER NOT NULL,
    "hostedMinutesPublic" INTEGER NOT NULL,
    "hostedMinutesMacos" INTEGER NOT NULL,
    "hostedMinutesLinux" INTEGER NOT NULL,
    "hostedMinutesWindows" INTEGER NOT NULL,
    "peakParallel" INTEGER NOT NULL,
    "saturatedS" INTEGER NOT NULL,
    "jobsQueuedOver10m" INTEGER NOT NULL,
    "saturationQueueS" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'jobrequests',

    CONSTRAINT "DailyAzureUsage_pkey" PRIMARY KEY ("installationId","day")
);

-- CreateTable
CREATE TABLE "AzureUsageSnapshot" (
    "installationId" BIGINT NOT NULL,
    "month" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "usedMinutes" INTEGER NOT NULL,
    "totalMinutes" INTEGER,
    "usedParallel" INTEGER NOT NULL,
    "totalParallel" INTEGER NOT NULL,
    "isPremium" BOOLEAN,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzureUsageSnapshot_pkey" PRIMARY KEY ("installationId","month","source")
);

-- CreateTable
CREATE TABLE "AzureHookSubscription" (
    "installationId" BIGINT NOT NULL,
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "projectId" TEXT,
    "status" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AzureHookSubscription_pkey" PRIMARY KEY ("installationId","id")
);

-- CreateTable
CREATE TABLE "PipelineRollupDirty" (
    "installationId" BIGINT NOT NULL,
    "day" DATE NOT NULL,
    "markedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PipelineRollupDirty_pkey" PRIMARY KEY ("installationId","day")
);

-- CreateTable
CREATE TABLE "DailyPipelineStat" (
    "installationId" BIGINT NOT NULL,
    "projectId" TEXT NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "defaultBranch" BOOLEAN NOT NULL,
    "repositoryId" BIGINT,
    "builds" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL,
    "partial" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "canceled" INTEGER NOT NULL,
    "timedOut" INTEGER NOT NULL,
    "firstTrySuccess" INTEGER NOT NULL,
    "flakyRecovered" INTEGER NOT NULL,
    "durSumS" BIGINT NOT NULL,
    "durationHist" INTEGER[],
    "queueHist" INTEGER[],
    "jobSecondsHostedLinux" INTEGER NOT NULL,
    "jobSecondsHostedWindows" INTEGER NOT NULL,
    "jobSecondsHostedMacos" INTEGER NOT NULL,
    "jobSecondsSelfHosted" INTEGER NOT NULL,
    "jobsNearCap" INTEGER NOT NULL,

    CONSTRAINT "DailyPipelineStat_pkey" PRIMARY KEY ("installationId","projectId","definitionId","day","defaultBranch")
);

-- CreateIndex
CREATE UNIQUE INDEX "AzureDevOpsConnection_orgId_key" ON "AzureDevOpsConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AzureDevOpsConnection_hookKey_key" ON "AzureDevOpsConnection"("hookKey");

-- CreateIndex
CREATE INDEX "AzurePipelineDefinition_installationId_repositoryId_idx" ON "AzurePipelineDefinition"("installationId", "repositoryId");

-- CreateIndex
CREATE INDEX "AzurePipelineDefinition_installationId_manualRepositoryId_idx" ON "AzurePipelineDefinition"("installationId", "manualRepositoryId");

-- CreateIndex
CREATE INDEX "AzureBuild_installationId_repositoryId_queuedAt_idx" ON "AzureBuild"("installationId", "repositoryId", "queuedAt" DESC);

-- CreateIndex
CREATE INDEX "AzureBuild_installationId_headSha_idx" ON "AzureBuild"("installationId", "headSha");

-- CreateIndex
CREATE INDEX "AzureBuild_installationId_status_idx" ON "AzureBuild"("installationId", "status");

-- CreateIndex
CREATE INDEX "AzureBuild_installationId_definitionId_queuedAt_idx" ON "AzureBuild"("installationId", "definitionId", "queuedAt");

-- CreateIndex
CREATE INDEX "AzureBuild_installationId_queuedAt_idx" ON "AzureBuild"("installationId", "queuedAt" DESC);

-- CreateIndex
CREATE INDEX "AzureBuildJob_installationId_startedAt_idx" ON "AzureBuildJob"("installationId", "startedAt");

-- CreateIndex
CREATE INDEX "AzureBuildJob_installationId_repositoryId_idx" ON "AzureBuildJob"("installationId", "repositoryId");

-- CreateIndex
CREATE INDEX "AzureJobRequest_installationId_queueTime_idx" ON "AzureJobRequest"("installationId", "queueTime");

-- CreateIndex
CREATE INDEX "AzureJobRequest_installationId_jobId_idx" ON "AzureJobRequest"("installationId", "jobId");

-- CreateIndex
CREATE INDEX "DailyPipelineStat_installationId_day_idx" ON "DailyPipelineStat"("installationId", "day");

-- CreateIndex
CREATE INDEX "DailyPipelineStat_installationId_repositoryId_day_idx" ON "DailyPipelineStat"("installationId", "repositoryId", "day");

-- AddForeignKey
ALTER TABLE "AzureDevOpsConnection" ADD CONSTRAINT "AzureDevOpsConnection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AzureDevOpsProject" ADD CONSTRAINT "AzureDevOpsProject_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "AzureDevOpsConnection"("installationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AzurePipelineDefinition" ADD CONSTRAINT "AzurePipelineDefinition_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "AzureDevOpsConnection"("installationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AzurePipelineDefinition" ADD CONSTRAINT "AzurePipelineDefinition_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AzurePipelineDefinition" ADD CONSTRAINT "AzurePipelineDefinition_manualRepositoryId_fkey" FOREIGN KEY ("manualRepositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AzureBuild" ADD CONSTRAINT "AzureBuild_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "AzureDevOpsConnection"("installationId") ON DELETE CASCADE ON UPDATE CASCADE;
