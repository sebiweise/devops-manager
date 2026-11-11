-- CreateEnum
CREATE TYPE "AppRole" AS ENUM ('VIEWER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "RepoSelection" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD', 'SKIPPED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('RUN_RERUN', 'RUN_RERUN_FAILED', 'RUN_CANCEL', 'RUN_FORCE_CANCEL', 'VAR_CREATE', 'VAR_UPDATE', 'VAR_DELETE', 'VAR_BULK', 'VAR_BULK_REVERT', 'ORG_VAR_CREATE', 'ORG_VAR_UPDATE', 'ORG_VAR_DELETE', 'PR_MERGE', 'PR_BULK_MERGE', 'SYNC_NOW', 'MANAGEMENT_TOGGLE', 'SETTINGS_UPDATE', 'DATA_PURGE', 'DELIVERY_REPLAY', 'ROLE_UPDATE', 'USER_DISABLE', 'USER_ENABLE', 'SKU_RATE_UPDATE', 'BILLING_CREDENTIAL_SET', 'BILLING_CREDENTIAL_CONNECT', 'BILLING_CREDENTIAL_REVOKE');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'DENIED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "locale" TEXT,
    "oidcGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "envRole" "AppRole",
    "roleOverride" "AppRole",
    "roleOverrideBy" TEXT,
    "roleOverrideAt" TIMESTAMPTZ(3),
    "disabledAt" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Installation" (
    "id" BIGINT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "repositorySelection" "RepoSelection" NOT NULL,
    "permissions" JSONB NOT NULL,
    "events" TEXT[],
    "permissionsCheckedAt" TIMESTAMPTZ(3),
    "managementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "rawRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "includedMinutes" INTEGER,
    "planName" TEXT,
    "suspendedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "purgeAfter" TIMESTAMPTZ(3),
    "lastWebhookAt" TIMESTAMPTZ(3),
    "lastReconciledAt" TIMESTAMPTZ(3),
    "reconcileLockedUntil" TIMESTAMPTZ(3),
    "hookDeliveryCursor" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" BIGINT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "hasSelfHosted" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "repositoryId" BIGINT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "runsCursor" TIMESTAMPTZ(3),
    "backfillUntil" TIMESTAMPTZ(3),
    "backfillDone" BOOLEAN NOT NULL DEFAULT false,
    "runsEtag" TEXT,
    "needsResync" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("repositoryId")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "installationId" BIGINT,
    "repositoryId" BIGINT,
    "payloadBytes" INTEGER NOT NULL,
    "payload" JSONB,
    "status" "DeliveryStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "error" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "installationId" BIGINT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorDisplay" TEXT NOT NULL,
    "actorRole" "AppRole" NOT NULL,
    "actorProvider" TEXT NOT NULL,
    "actingAs" TEXT,
    "action" "AuditAction" NOT NULL,
    "repositoryId" BIGINT,
    "repoFullName" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "batchId" TEXT,
    "params" JSONB NOT NULL,
    "confirmation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AuditStatus" NOT NULL,
    "httpStatus" INTEGER,
    "githubRequestId" TEXT,
    "error" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Installation_accountLogin_key" ON "Installation"("accountLogin");

-- CreateIndex
CREATE INDEX "Repository_installationId_removedAt_idx" ON "Repository"("installationId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_installationId_fullName_key" ON "Repository"("installationId", "fullName");

-- CreateIndex
CREATE INDEX "SyncState_installationId_idx" ON "SyncState"("installationId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_receivedAt_idx" ON "WebhookDelivery"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_installationId_receivedAt_idx" ON "WebhookDelivery"("installationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_idempotencyKey_key" ON "AuditLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_installationId_createdAt_idx" ON "AuditLog"("installationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_batchId_idx" ON "AuditLog"("batchId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
