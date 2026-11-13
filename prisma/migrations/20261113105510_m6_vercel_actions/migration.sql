-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_MANAGEMENT_TOGGLE';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_REDEPLOY';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_CANCEL';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_PROMOTE';
ALTER TYPE "AuditAction" ADD VALUE 'VERCEL_ROLLBACK';

-- AlterTable
ALTER TABLE "VercelDeployment" ADD COLUMN     "auditLinkKind" TEXT;

-- AlterTable
ALTER TABLE "VercelProject" ADD COLUMN     "aliasRequestAt" TIMESTAMPTZ(3),
ADD COLUMN     "aliasRequestStatus" TEXT,
ADD COLUMN     "aliasRequestType" TEXT,
ADD COLUMN     "aliasToDeploymentId" TEXT;
