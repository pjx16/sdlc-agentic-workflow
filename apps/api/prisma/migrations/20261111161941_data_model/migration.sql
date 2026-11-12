-- CreateEnum
CREATE TYPE "ProjectStack" AS ENUM ('ts_node', 'nestjs', 'nextjs');

-- CreateEnum
CREATE TYPE "ClaudeMdMode" AS ENUM ('ours', 'theirs', 'both');

-- CreateEnum
CREATE TYPE "JiraMode" AS ENUM ('rest', 'mcp', 'off');

-- CreateEnum
CREATE TYPE "MirrorStatus" AS ENUM ('pending', 'ok', 'failed');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('jira', 'paste');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('story', 'bug', 'tech');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE', 'AWAITING_CI', 'IN_HUMAN_REVIEW', 'DONE', 'ON_HOLD', 'FAILED');

-- CreateEnum
CREATE TYPE "HoldReason" AS ENUM ('awaiting_answer', 'needs_help', 'manual', 'pr_closed');

-- CreateEnum
CREATE TYPE "Actor" AS ENUM ('system', 'user', 'jira');

-- CreateEnum
CREATE TYPE "JiraSyncResult" AS ENUM ('none', 'applied', 'failed');

-- CreateEnum
CREATE TYPE "SubtaskStatus" AS ENUM ('PENDING', 'TESTS', 'VERIFY_RED', 'IMPLEMENT', 'VERIFY_GREEN', 'FIXING', 'DONE');

-- CreateEnum
CREATE TYPE "StageRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'needs_input', 'killed');

-- CreateEnum
CREATE TYPE "FixReason" AS ENUM ('tests', 'review', 'ci');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('open', 'fixed', 'accepted');

-- CreateEnum
CREATE TYPE "SupportQueryStatus" AS ENUM ('open', 'answered');

-- CreateEnum
CREATE TYPE "UsageSource" AS ENUM ('event', 'estimate');

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(6),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL DEFAULT 'dev',
    "stack" "ProjectStack" NOT NULL,
    "installCmd" TEXT NOT NULL DEFAULT '',
    "typecheckCmd" TEXT NOT NULL DEFAULT '',
    "testCmdTemplate" TEXT NOT NULL,
    "kbDir" TEXT NOT NULL DEFAULT 'docs/kb',
    "claudeMdMode" "ClaudeMdMode" NOT NULL DEFAULT 'both',
    "jiraMode" "JiraMode" NOT NULL DEFAULT 'off',
    "jiraProjectKey" TEXT,
    "jiraJql" TEXT,
    "localKeyPrefix" TEXT NOT NULL,
    "nextLocalNumber" INTEGER NOT NULL DEFAULT 1,
    "mirrorStatus" "MirrorStatus" NOT NULL DEFAULT 'pending',
    "mirrorError" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "usageThresholdPct" INTEGER NOT NULL DEFAULT 50,
    "usageThresholdWeeklyPct" INTEGER NOT NULL DEFAULT 80,
    "calibratedWindowTokens" BIGINT,
    "usageIgnoredUntil" TIMESTAMPTZ(6),
    "pipelinePaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedReason" TEXT,
    "resetsAt" TIMESTAMPTZ(6),
    "intakePaused" BOOLEAN NOT NULL DEFAULT false,
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 120,
    "stageTimeoutMin" INTEGER NOT NULL DEFAULT 20,
    "verifyTimeoutSec" INTEGER NOT NULL DEFAULT 600,
    "workspaceRetentionDays" INTEGER NOT NULL DEFAULT 7,
    "logRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "modelAliases" JSONB NOT NULL DEFAULT '{"haiku":"haiku","sonnet":"sonnet","opus":"opus"}',
    "jiraMcp" JSONB NOT NULL DEFAULT '{"readTools":[],"writeTools":[]}',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GlobalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "source" "TicketSource" NOT NULL,
    "externalKey" TEXT,
    "type" "TicketType" NOT NULL DEFAULT 'story',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "featureKey" TEXT,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "holdReason" "HoldReason",
    "holdFromStatus" "TicketStatus",
    "branch" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "planMarkdown" TEXT,
    "reviewRound" INTEGER NOT NULL DEFAULT 0,
    "lastReviewedSha" TEXT,
    "ciFixPending" BOOLEAN NOT NULL DEFAULT false,
    "ciFixDone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StateTransition" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromStatus" "TicketStatus" NOT NULL,
    "toStatus" "TicketStatus" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" "Actor" NOT NULL,
    "reason" TEXT,
    "stageRunId" TEXT,
    "jiraStatusApplied" TEXT,
    "jiraSyncResult" "JiraSyncResult" NOT NULL DEFAULT 'none',
    "jiraSyncError" TEXT,

    CONSTRAINT "StateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtask" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "externalKey" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "acceptanceCriteria" JSONB NOT NULL DEFAULT '[]',
    "files" JSONB NOT NULL DEFAULT '[]',
    "dependsOn" JSONB NOT NULL DEFAULT '[]',
    "status" "SubtaskStatus" NOT NULL DEFAULT 'PENDING',
    "fixRounds" INTEGER NOT NULL DEFAULT 0,
    "testFiles" JSONB NOT NULL DEFAULT '[]',
    "testCommit" TEXT,
    "featCommit" TEXT,

    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageRun" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "projectId" TEXT NOT NULL,
    "subtaskId" TEXT,
    "stage" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "round" INTEGER NOT NULL DEFAULT 0,
    "reason" "FixReason",
    "status" "StageRunStatus" NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "killRequested" BOOLEAN NOT NULL DEFAULT false,
    "containerId" TEXT,
    "cliVersion" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "numTurns" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "resultJson" JSONB,
    "logPath" TEXT,
    "error" TEXT,

    CONSTRAINT "StageRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER,
    "issue" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "fix" TEXT NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'open',

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportQuery" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "stageRunId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "SupportQueryStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMPTZ(6),

    CONSTRAINT "SupportQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSnapshot" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fiveHourPct" DOUBLE PRECISION,
    "sevenDayPct" DOUBLE PRECISION,
    "status" TEXT,
    "resetsAt" TIMESTAMPTZ(6),
    "source" "UsageSource" NOT NULL,
    "windowTokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE INDEX "Ticket_status_createdAt_idx" ON "Ticket"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_projectId_key_key" ON "Ticket"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_projectId_externalKey_key" ON "Ticket"("projectId", "externalKey");

-- CreateIndex
CREATE INDEX "StateTransition_ticketId_at_idx" ON "StateTransition"("ticketId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Subtask_ticketId_seq_key" ON "Subtask"("ticketId", "seq");

-- CreateIndex
CREATE INDEX "StageRun_status_idx" ON "StageRun"("status");

-- CreateIndex
CREATE INDEX "StageRun_ticketId_startedAt_idx" ON "StageRun"("ticketId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportQuery_status_idx" ON "SupportQuery"("status");

-- CreateIndex
CREATE INDEX "Event_ticketId_at_idx" ON "Event"("ticketId", "at");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StateTransition" ADD CONSTRAINT "StateTransition_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageRun" ADD CONSTRAINT "StageRun_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageRun" ADD CONSTRAINT "StageRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageRun" ADD CONSTRAINT "StageRun_subtaskId_fkey" FOREIGN KEY ("subtaskId") REFERENCES "Subtask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportQuery" ADD CONSTRAINT "SupportQuery_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportQuery" ADD CONSTRAINT "SupportQuery_stageRunId_fkey" FOREIGN KEY ("stageRunId") REFERENCES "StageRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
