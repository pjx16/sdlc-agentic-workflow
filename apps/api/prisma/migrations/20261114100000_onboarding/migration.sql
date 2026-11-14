-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('draft', 'profiling', 'proposed', 'confirmed');
CREATE TYPE "TicketKind" AS ENUM ('feature', 'bug', 'chore');

-- AlterTable: existing projects are already set up, so they start confirmed.
ALTER TABLE "Project" ADD COLUMN "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'confirmed',
ADD COLUMN "onboardingProposal" JSONB,
ADD COLUMN "onboardingError" TEXT;

-- AlterTable: what a ticket is. Old tickets take it from their type (story -> feature, bug -> bug, tech -> chore).
ALTER TABLE "Ticket" ADD COLUMN "kind" "TicketKind" NOT NULL DEFAULT 'feature';
UPDATE "Ticket" SET "kind" = 'bug' WHERE "type" = 'bug';
UPDATE "Ticket" SET "kind" = 'chore' WHERE "type" = 'tech';

-- CreateIndex
CREATE INDEX "Project_onboardingStatus_idx" ON "Project"("onboardingStatus");
