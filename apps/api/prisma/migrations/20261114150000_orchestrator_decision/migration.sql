CREATE TABLE "OrchestratorDecision" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "point" TEXT NOT NULL,
    "legalMoves" JSONB NOT NULL,
    "chosen" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "stageRunId" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,

    CONSTRAINT "OrchestratorDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrchestratorDecision_ticketId_at_idx" ON "OrchestratorDecision"("ticketId", "at");
CREATE INDEX "OrchestratorDecision_at_idx" ON "OrchestratorDecision"("at");

ALTER TABLE "OrchestratorDecision" ADD CONSTRAINT "OrchestratorDecision_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
