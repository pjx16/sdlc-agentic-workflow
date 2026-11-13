-- Jira is reached over REST only (BUILD_PLAN v1 D5). Projects in MCP mode become REST projects.
UPDATE "Project" SET "jiraMode" = 'rest' WHERE "jiraMode" = 'mcp';

-- Postgres cannot drop an enum value: replace the type.
ALTER TYPE "JiraMode" RENAME TO "JiraMode_old";
CREATE TYPE "JiraMode" AS ENUM ('rest', 'off');
ALTER TABLE "Project" ALTER COLUMN "jiraMode" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "jiraMode" TYPE "JiraMode" USING ("jiraMode"::text::"JiraMode");
ALTER TABLE "Project" ALTER COLUMN "jiraMode" SET DEFAULT 'off';
DROP TYPE "JiraMode_old";

-- The MCP tool lists are no longer used.
ALTER TABLE "GlobalSettings" DROP COLUMN "jiraMcp";
