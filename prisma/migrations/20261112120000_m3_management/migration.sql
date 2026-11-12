-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "resultHash" TEXT;

-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "redactVariableValues" BOOLEAN NOT NULL DEFAULT false;
