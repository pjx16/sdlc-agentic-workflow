-- A hold for a back-edge that went round too often (BUILD_PLAN v1 6.8).
ALTER TYPE "HoldReason" ADD VALUE 'loop_limit';

-- Every move has a kind and may carry a note (the person's instructions for a rerun, or the reason for a rejection).
-- Old transitions are plain advances.
ALTER TABLE "StateTransition" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'advance',
ADD COLUMN "note" TEXT;

-- A run that a rerun made obsolete is marked, never deleted. Stages that write code record the commit range they covered.
ALTER TABLE "StageRun" ADD COLUMN "startSha" TEXT,
ADD COLUMN "endSha" TEXT,
ADD COLUMN "supersededAt" TIMESTAMPTZ(6),
ADD COLUMN "supersededByTransitionId" TEXT,
ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'auto';

-- A rerun records where the stale work starts, and the worker removes it with a revert commit before the stage runs again.
ALTER TABLE "Ticket" ADD COLUMN "revertFromSha" TEXT,
ADD COLUMN "revertStage" TEXT;

-- Rerun of one subtask: its tests, or its implementation.
ALTER TABLE "Subtask" ADD COLUMN "rerunPart" TEXT;

-- Every version of each stage's output (plan, breakdown, review findings of a round, the knowledge-base pointer).
CREATE TABLE "StageArtifact" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "stageRunId" TEXT,
    "supersededAt" TIMESTAMPTZ(6),
    "externalUrl" TEXT,
    "externalId" TEXT,
    "externalVersion" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StageArtifact_ticketId_stage_version_key" ON "StageArtifact"("ticketId", "stage", "version");
CREATE INDEX "StageArtifact_ticketId_stage_idx" ON "StageArtifact"("ticketId", "stage");
CREATE INDEX "StageRun_supersededAt_idx" ON "StageRun"("supersededAt");

ALTER TABLE "StageArtifact" ADD CONSTRAINT "StageArtifact_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
