-- SupportQuery becomes SupportTicket (BUILD_PLAN v1 6.5). Existing rows are kept as `question` tickets that block.

-- New enums
CREATE TYPE "SupportKind" AS ENUM ('approval', 'question', 'open_question', 'hold', 'ci_infra', 'onboarding', 'credential', 'pr_ready');
CREATE TYPE "SupportPriority" AS ENUM ('blocking', 'normal', 'fyi');

-- The status enum gets two more values and a new name.
ALTER TYPE "SupportQueryStatus" RENAME TO "SupportStatus";
ALTER TYPE "SupportStatus" ADD VALUE 'resolved';
ALTER TYPE "SupportStatus" ADD VALUE 'dismissed';

-- Rename the table and its columns.
ALTER TABLE "SupportQuery" RENAME TO "SupportTicket";
ALTER TABLE "SupportTicket" RENAME CONSTRAINT "SupportQuery_pkey" TO "SupportTicket_pkey";
ALTER TABLE "SupportTicket" RENAME CONSTRAINT "SupportQuery_ticketId_fkey" TO "SupportTicket_ticketId_fkey";
ALTER TABLE "SupportTicket" RENAME CONSTRAINT "SupportQuery_stageRunId_fkey" TO "SupportTicket_stageRunId_fkey";
ALTER INDEX "SupportQuery_status_idx" RENAME TO "SupportTicket_status_idx";
ALTER TABLE "SupportTicket" RENAME COLUMN "question" TO "body";
ALTER TABLE "SupportTicket" RENAME COLUMN "answer" TO "response";
ALTER TABLE "SupportTicket" RENAME COLUMN "answeredAt" TO "resolvedAt";

-- New columns
ALTER TABLE "SupportTicket"
  ADD COLUMN "kind" "SupportKind" NOT NULL DEFAULT 'question',
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "priority" "SupportPriority" NOT NULL DEFAULT 'blocking',
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "defaultAnswer" TEXT,
  ADD COLUMN "resolvedBy" TEXT,
  ADD COLUMN "dedupeKey" TEXT;

UPDATE "SupportTicket" t SET "title" = LEFT(t."body", 120), "projectId" = k."projectId" FROM "Ticket" k WHERE k."id" = t."ticketId";
UPDATE "SupportTicket" SET "resolvedBy" = 'user' WHERE "status" = 'answered';

-- Global items (a credential) have no ticket or run.
ALTER TABLE "SupportTicket" ALTER COLUMN "ticketId" DROP NOT NULL;
ALTER TABLE "SupportTicket" ALTER COLUMN "stageRunId" DROP NOT NULL;
ALTER TABLE "SupportTicket" ALTER COLUMN "title" DROP DEFAULT;

ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same problem never opens two tickets: at most one OPEN ticket per dedupe key.
CREATE UNIQUE INDEX "SupportTicket_open_dedupeKey_key" ON "SupportTicket"("dedupeKey") WHERE "status" = 'open' AND "dedupeKey" IS NOT NULL;
CREATE INDEX "SupportTicket_kind_status_idx" ON "SupportTicket"("kind", "status");
CREATE INDEX "SupportTicket_ticketId_idx" ON "SupportTicket"("ticketId");
