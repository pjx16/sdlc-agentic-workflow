-- Merge time and PR size, recorded when the worker sees the PR merged.
ALTER TABLE "Ticket" ADD COLUMN "mergedAt" TIMESTAMPTZ(6),
ADD COLUMN "prAdditions" INTEGER,
ADD COLUMN "prDeletions" INTEGER,
ADD COLUMN "prChangedFiles" INTEGER;

CREATE INDEX "Ticket_mergedAt_idx" ON "Ticket"("mergedAt");

-- Tickets that finished before this column existed: use the time they became DONE. Their line counts stay empty.
UPDATE "Ticket" t SET "mergedAt" = (SELECT max(s."at") FROM "StateTransition" s WHERE s."ticketId" = t.id AND s."toStatus" = 'DONE')
WHERE t.status = 'DONE' AND t."mergedAt" IS NULL;
