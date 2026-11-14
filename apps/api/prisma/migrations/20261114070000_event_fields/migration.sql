-- AlterTable
ALTER TABLE "Event" ADD COLUMN "level" TEXT NOT NULL DEFAULT 'info',
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'system',
ADD COLUMN "stageRunId" TEXT,
ADD COLUMN "subtaskId" TEXT,
ADD COLUMN "errorCode" TEXT,
ADD COLUMN "data" JSONB;

-- Old rows: the coarse type tells the source, and an error event is an error.
UPDATE "Event" SET "source" = "type" WHERE "type" IN ('jira', 'git');
UPDATE "Event" SET "source" = 'user' WHERE "type" = 'support';
UPDATE "Event" SET "level" = 'error' WHERE "type" = 'error';
UPDATE "Event" SET "level" = 'warn' WHERE "type" IN ('jira', 'git') AND ("message" ILIKE '%failed%' OR "message" ILIKE 'warning:%' OR "message" ILIKE '%could not%');

-- Rows written by code that does not set level and source yet get the same treatment, so nothing is mislabelled.
-- Code that sets them explicitly (the typed helpers) is never changed.
CREATE FUNCTION "event_defaults"() RETURNS trigger AS $$
BEGIN
  IF NEW."source" = 'system' THEN
    IF NEW."type" IN ('jira', 'git') THEN NEW."source" := NEW."type";
    ELSIF NEW."type" = 'support' THEN NEW."source" := 'user';
    END IF;
  END IF;
  IF NEW."level" = 'info' THEN
    IF NEW."type" = 'error' THEN NEW."level" := 'error';
    ELSIF NEW."type" IN ('jira', 'git') AND (NEW."message" ILIKE '%failed%' OR NEW."message" ILIKE 'warning:%' OR NEW."message" ILIKE '%could not%') THEN NEW."level" := 'warn';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "event_defaults_trigger" BEFORE INSERT ON "Event" FOR EACH ROW EXECUTE FUNCTION "event_defaults"();

-- CreateIndex
CREATE INDEX "Event_at_idx" ON "Event"("at");
CREATE INDEX "Event_level_at_idx" ON "Event"("level", "at");
