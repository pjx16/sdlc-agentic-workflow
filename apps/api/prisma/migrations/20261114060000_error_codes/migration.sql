-- AlterTable
ALTER TABLE "StageRun" ADD COLUMN "errorCode" TEXT,
ADD COLUMN "errorSource" TEXT,
ADD COLUMN "retryAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN "pausedCode" TEXT;
