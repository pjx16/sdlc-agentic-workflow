-- AlterTable
ALTER TABLE "UsageSnapshot" ADD COLUMN "stageRunId" TEXT,
ADD COLUMN "model" TEXT,
ADD COLUMN "windows" JSONB;

-- CreateIndex
CREATE INDEX "UsageSnapshot_at_idx" ON "UsageSnapshot"("at");
