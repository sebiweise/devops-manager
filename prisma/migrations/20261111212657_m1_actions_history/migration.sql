-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('REQUESTED', 'QUEUED', 'WAITING', 'PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'WAITING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "Conclusion" AS ENUM ('SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'TIMED_OUT', 'ACTION_REQUIRED', 'NEUTRAL', 'STALE', 'STARTUP_FAILURE');

-- CreateEnum
CREATE TYPE "RunnerKind" AS ENUM ('GITHUB_HOSTED', 'LARGER_HOSTED', 'SELF_HOSTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RunnerOs" AS ENUM ('LINUX', 'WINDOWS', 'MACOS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('WEBHOOK', 'BACKFILL', 'RECONCILE');

-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "lastPrunedAt" TIMESTAMPTZ(3),
ADD COLUMN     "syncRequestedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" BIGINT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "workflowId" BIGINT,
    "workflowName" TEXT NOT NULL,
    "workflowPath" TEXT,
    "event" TEXT,
    "headBranch" TEXT,
    "headSha" TEXT NOT NULL,
    "isDefaultBranch" BOOLEAN NOT NULL DEFAULT false,
    "actorLogin" TEXT,
    "runNumber" INTEGER,
    "runAttempt" INTEGER NOT NULL DEFAULT 1,
    "firstAttemptConclusion" "Conclusion",
    "status" "RunStatus" NOT NULL,
    "statusRank" SMALLINT NOT NULL,
    "conclusion" "Conclusion",
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "runStartedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "durationS" INTEGER,
    "isPlaceholder" BOOLEAN NOT NULL DEFAULT false,
    "htmlUrl" TEXT,
    "githubUpdatedAt" TIMESTAMPTZ(3),
    "jobsSyncedAt" TIMESTAMPTZ(3),
    "source" "Source" NOT NULL,
    "lastEventAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowJob" (
    "id" BIGINT NOT NULL,
    "runId" BIGINT NOT NULL,
    "runAttempt" INTEGER NOT NULL,
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "workflowId" BIGINT,
    "workflowName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseName" TEXT NOT NULL,
    "labels" TEXT[],
    "labelKey" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "statusRank" SMALLINT NOT NULL,
    "conclusion" "Conclusion",
    "runnerId" BIGINT,
    "runnerName" TEXT,
    "runnerGroupId" BIGINT,
    "runnerGroupName" TEXT,
    "runnerKind" "RunnerKind" NOT NULL DEFAULT 'UNKNOWN',
    "runnerOs" "RunnerOs" NOT NULL DEFAULT 'UNKNOWN',
    "sku" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "waitingStartedAt" TIMESTAMPTZ(3),
    "lastQueuedAt" TIMESTAMPTZ(3),
    "waitingS" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "queueS" INTEGER,
    "durationS" INTEGER,
    "billableMinEst" INTEGER,
    "source" "Source" NOT NULL,
    "lastEventAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RollupDirty" (
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "day" DATE NOT NULL,
    "markedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RollupDirty_pkey" PRIMARY KEY ("installationId","repositoryId","day")
);

-- CreateTable
CREATE TABLE "DailyWorkflowStat" (
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "workflowId" BIGINT NOT NULL,
    "workflowName" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "defaultBranch" BOOLEAN NOT NULL,
    "runs" INTEGER NOT NULL,
    "success" INTEGER NOT NULL,
    "failure" INTEGER NOT NULL,
    "cancelled" INTEGER NOT NULL,
    "other" INTEGER NOT NULL,
    "firstTrySuccess" INTEGER NOT NULL,
    "flakyRecovered" INTEGER NOT NULL,
    "durSumS" BIGINT NOT NULL,
    "durHist" INTEGER[],
    "queueHist" INTEGER[],
    "jobSecondsLinux" INTEGER NOT NULL,
    "jobSecondsWindows" INTEGER NOT NULL,
    "jobSecondsMacos" INTEGER NOT NULL,
    "jobSecondsSelfHosted" INTEGER NOT NULL,
    "billableMinEst" INTEGER NOT NULL,

    CONSTRAINT "DailyWorkflowStat_pkey" PRIMARY KEY ("workflowId","day","defaultBranch")
);

-- CreateTable
CREATE TABLE "DailyJobStat" (
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "workflowId" BIGINT NOT NULL,
    "baseName" TEXT NOT NULL,
    "labelKey" TEXT NOT NULL,
    "runnerKind" "RunnerKind" NOT NULL,
    "day" DATE NOT NULL,
    "jobs" INTEGER NOT NULL,
    "success" INTEGER NOT NULL,
    "failure" INTEGER NOT NULL,
    "durSumS" BIGINT NOT NULL,
    "durHist" INTEGER[],
    "queueHist" INTEGER[],
    "billableMinEst" INTEGER NOT NULL,

    CONSTRAINT "DailyJobStat_pkey" PRIMARY KEY ("workflowId","baseName","labelKey","runnerKind","day")
);

-- CreateTable
CREATE TABLE "SkuRate" (
    "sku" TEXT NOT NULL,
    "os" "RunnerOs" NOT NULL,
    "cores" INTEGER,
    "labelPattern" TEXT,
    "minuteMultiplier" DECIMAL(8,3) NOT NULL,
    "pricePerMinuteUsd" DECIMAL(10,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,

    CONSTRAINT "SkuRate_pkey" PRIMARY KEY ("sku","effectiveFrom")
);

-- CreateTable
CREATE TABLE "AppState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppState_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "InstallationRateLimit" (
    "installationId" BIGINT NOT NULL,
    "resource" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "resetAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstallationRateLimit_pkey" PRIMARY KEY ("installationId","resource")
);

-- CreateIndex
CREATE INDEX "WorkflowRun_installationId_createdAt_idx" ON "WorkflowRun"("installationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_repositoryId_createdAt_idx" ON "WorkflowRun"("repositoryId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_repositoryId_workflowId_createdAt_idx" ON "WorkflowRun"("repositoryId", "workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowJob_installationId_completedAt_idx" ON "WorkflowJob"("installationId", "completedAt");

-- CreateIndex
CREATE INDEX "WorkflowJob_repositoryId_workflowId_completedAt_idx" ON "WorkflowJob"("repositoryId", "workflowId", "completedAt");

-- CreateIndex
CREATE INDEX "WorkflowJob_runId_idx" ON "WorkflowJob"("runId");

-- CreateIndex
CREATE INDEX "WorkflowJob_installationId_runnerName_startedAt_idx" ON "WorkflowJob"("installationId", "runnerName", "startedAt");

-- CreateIndex
CREATE INDEX "DailyWorkflowStat_installationId_day_idx" ON "DailyWorkflowStat"("installationId", "day");

-- CreateIndex
CREATE INDEX "DailyWorkflowStat_repositoryId_day_idx" ON "DailyWorkflowStat"("repositoryId", "day");

-- CreateIndex
CREATE INDEX "DailyJobStat_installationId_day_idx" ON "DailyJobStat"("installationId", "day");

-- ---------- raw SQL (not expressible in schema.prisma) ----------

-- Partial indexes: open runs and jobs (reconcile step c) and the live queue.
CREATE INDEX "WorkflowRun_open_idx" ON "WorkflowRun" ("installationId", "lastEventAt") WHERE "status" <> 'COMPLETED';
CREATE INDEX "WorkflowJob_open_idx" ON "WorkflowJob" ("installationId", "lastEventAt") WHERE "status" <> 'COMPLETED';
CREATE INDEX "WorkflowJob_queued_idx" ON "WorkflowJob" ("installationId", "labelKey", "createdAt") WHERE "status" IN ('QUEUED', 'WAITING');

-- Histogram codec (src/server/metrics/histogram.ts has the same rules; tests
-- check that both agree). 80 buckets: bucket 0 is < 1 s, bucket i (1..79)
-- covers [2^((i-1)/4), 2^(i/4)) seconds. Arrays are 1-based in SQL.
CREATE OR REPLACE FUNCTION hist_bucket(seconds double precision) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN seconds IS NULL THEN NULL
    WHEN seconds < 1 THEN 0
    ELSE LEAST(79, floor(4 * ln(seconds) / ln(2) + 1e-9)::integer + 1)
  END
$$;

CREATE OR REPLACE FUNCTION hist_add(h integer[], seconds double precision) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  b integer;
BEGIN
  IF h IS NULL THEN
    h := array_fill(0, ARRAY[80]);
  END IF;
  IF seconds IS NULL THEN
    RETURN h;
  END IF;
  b := hist_bucket(seconds) + 1;
  h[b] := h[b] + 1;
  RETURN h;
END
$$;

-- Element-wise sum of two histograms.
CREATE OR REPLACE FUNCTION hist_merge(a integer[], b integer[]) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN a IS NULL THEN b
    WHEN b IS NULL THEN a
    ELSE ARRAY(
      SELECT coalesce(x, 0) + coalesce(y, 0)
      FROM unnest(a, b) WITH ORDINALITY AS t(x, y, i)
      ORDER BY i
    )
  END
$$;

-- hist_agg(seconds): builds a histogram from raw values (NULLs are ignored).
CREATE AGGREGATE hist_agg(double precision) (
  SFUNC = hist_add,
  STYPE = integer[],
  INITCOND = '{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}'
);

-- hist_sum(hist): merges histograms (rollup reads across days).
CREATE AGGREGATE hist_sum(integer[]) (
  SFUNC = hist_merge,
  STYPE = integer[]
);
