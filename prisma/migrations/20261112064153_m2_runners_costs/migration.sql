-- CreateEnum
CREATE TYPE "RunnerScope" AS ENUM ('ORG', 'REPO');

-- CreateEnum
CREATE TYPE "GitHubCredentialKind" AS ENUM ('PAT', 'USER_TO_SERVER');

-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "billingError" TEXT,
ADD COLUMN     "billingStatus" TEXT,
ADD COLUMN     "billingSyncedAt" TIMESTAMPTZ(3),
ADD COLUMN     "runnersDiscoveredAt" TIMESTAMPTZ(3),
ADD COLUMN     "runnersSampledAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "Runner" (
    "key" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "scope" "RunnerScope" NOT NULL,
    "repositoryId" BIGINT,
    "githubRunnerId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "labels" TEXT[],
    "groupName" TEXT,
    "online" BOOLEAN NOT NULL,
    "busy" BOOLEAN NOT NULL,
    "ephemeral" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastOnlineAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Runner_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RunnerSample" (
    "installationId" BIGINT NOT NULL,
    "runnerKey" TEXT NOT NULL,
    "sampledAt" TIMESTAMPTZ(3) NOT NULL,
    "online" BOOLEAN NOT NULL,
    "busy" BOOLEAN NOT NULL,
    "intervalS" INTEGER NOT NULL,

    CONSTRAINT "RunnerSample_pkey" PRIMARY KEY ("runnerKey","sampledAt")
);

-- CreateTable
CREATE TABLE "DailyRunnerStat" (
    "installationId" BIGINT NOT NULL,
    "runnerKey" TEXT NOT NULL,
    "runnerKind" "RunnerKind" NOT NULL,
    "day" DATE NOT NULL,
    "jobs" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "infraFailures" INTEGER NOT NULL DEFAULT 0,
    "busyS" BIGINT NOT NULL,
    "onlineS" BIGINT,
    "peakConcurrency" INTEGER NOT NULL,
    "durHist" INTEGER[],
    "queueHist" INTEGER[],
    "speedIndex" DOUBLE PRECISION,

    CONSTRAINT "DailyRunnerStat_pkey" PRIMARY KEY ("installationId","runnerKey","day")
);

-- CreateTable
CREATE TABLE "BillingUsageItem" (
    "installationId" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "product" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "repositoryFullName" TEXT NOT NULL DEFAULT '',
    "unitType" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "pricePerUnit" DECIMAL(18,6) NOT NULL,
    "grossAmount" DECIMAL(18,6) NOT NULL,
    "discountAmount" DECIMAL(18,6) NOT NULL,
    "netAmount" DECIMAL(18,6) NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingUsageItem_pkey" PRIMARY KEY ("installationId","date","product","sku","repositoryFullName")
);

-- CreateTable
CREATE TABLE "GitHubCredential" (
    "installationId" BIGINT NOT NULL,
    "kind" "GitHubCredentialKind" NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshToken" TEXT,
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "createdByUserId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "lastRefreshedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GitHubCredential_pkey" PRIMARY KEY ("installationId")
);

-- CreateIndex
CREATE INDEX "Runner_installationId_removedAt_idx" ON "Runner"("installationId", "removedAt");

-- CreateIndex
CREATE INDEX "Runner_installationId_name_idx" ON "Runner"("installationId", "name");

-- CreateIndex
CREATE INDEX "RunnerSample_installationId_sampledAt_idx" ON "RunnerSample"("installationId", "sampledAt");

-- CreateIndex
CREATE INDEX "DailyRunnerStat_installationId_day_idx" ON "DailyRunnerStat"("installationId", "day");

-- CreateIndex
CREATE INDEX "GitHubCredential_githubUserId_idx" ON "GitHubCredential"("githubUserId");

-- CreateIndex: label containment (labels @> job labels) for STUCK / no-matching-runner checks.
CREATE INDEX "Runner_labels_gin_idx" ON "Runner" USING GIN ("labels");
