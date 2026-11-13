import { z } from 'zod';
import { MODEL_ALIASES, TICKET_STATUSES, type StageName } from './enums';

const modelAlias = z.enum(MODEL_ALIASES);

/** `{ enabled, model, maxTurns }` with the section 7 defaults for that stage. */
function stage(model: (typeof MODEL_ALIASES)[number], maxTurns: number) {
  return z
    .object({
      enabled: z.boolean().default(true),
      model: modelAlias.default(model),
      maxTurns: z.number({ error: 'must be a number' }).int('must be a whole number').min(1, 'must be at least 1').max(200, 'must be at most 200').default(maxTurns),
    })
    .prefault({});
}

const implementStage = z
  .object({
    enabled: z.literal(true, { error: 'The implement stage cannot be disabled' }).default(true),
    model: modelAlias.default('haiku'),
    maxTurns: z.number({ error: 'must be a number' }).int().min(1, 'must be at least 1').max(200, 'must be at most 200').default(40),
  })
  .prefault({});

const count = (def: number, min: number, max: number) =>
  z.number({ error: 'must be a number' }).int('must be a whole number').min(min, `must be at least ${min}`).max(max, `must be at most ${max}`).default(def);

const statusMapShape = Object.fromEntries(
  TICKET_STATUSES.map((s) => [s, z.string().trim().min(1).nullable().default(null)]),
) as Record<(typeof TICKET_STATUSES)[number], z.ZodDefault<z.ZodNullable<z.ZodString>>>;

const regexString = z.string().min(1).refine((p) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

export const ProjectSettingsSchema = z.object({
  stages: z
    .object({
      kbBuild: stage('sonnet', 30),
      plan: stage('opus', 15),
      breakdown: stage('haiku', 10),
      tests: stage('sonnet', 25),
      implement: implementStage,
      fix: stage('sonnet', 15),
      review: stage('sonnet', 10),
      kbUpdate: stage('sonnet', 15),
      assist: stage('sonnet', 8),
      repoProfile: stage('sonnet', 25),
      onboardAdvise: stage('haiku', 5),
    })
    .prefault({}),
  gates: z.object({ plan: z.boolean().default(true), breakdown: z.boolean().default(true) }).prefault({}),
  intake: z
    .object({
      paste: z.boolean().default(true),
    })
    .prefault({}),
  jiraWriteBack: z
    .object({
      comments: z.boolean().default(true),
      transitions: z.boolean().default(true),
      createSubtasks: z.boolean().default(true),
    })
    .prefault({}),
  jiraSubtaskTypeName: z.string().trim().min(1, 'required').default('Sub-task'),
  /** What each Jira issue type becomes: feature, bug, chore, or ignore (BUILD_PLAN v1 6.7). */
  jiraIssueTypeRouting: z.record(z.string(), z.enum(['feature', 'bug', 'chore', 'ignore'])).default({}),
  /** Where plans are published (BUILD_PLAN v1 6.10). Null: plans go to Jira comments. */
  confluence: z.object({ spaceKey: z.string().min(1), parentPageId: z.string().nullable().default(null) }).nullable().default(null),
  jiraStatusMap: z.object(statusMapShape).prefault({}),
  jiraApprovalStatuses: z
    .object({ plan: z.string().trim().min(1).optional(), breakdown: z.string().trim().min(1).optional() })
    .prefault({}),
  pr: z
    .object({
      earlyDraft: z.boolean().default(true),
      ciFixRound: z.boolean().default(true),
      ciTimeoutMin: count(30, 1, 480),
    })
    .prefault({}),
  limits: z
    .object({
      maxSubtasks: count(8, 1, 50),
      maxTestFixRounds: count(2, 0, 10),
      maxReviewRounds: count(2, 0, 10),
      kbDocMaxLines: count(300, 50, 5000),
      reviewMaxDiffLines: count(4000, 100, 100_000),
    })
    .prefault({}),
  verify: z
    .object({
      redInvalidPatterns: z.array(regexString).default(['Cannot find module', 'SyntaxError', 'error TS[0-9]+']),
    })
    .prefault({}),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** All defaults, as stored when a project is created without explicit settings. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = ProjectSettingsSchema.parse({});

export interface Warning {
  /** Dotted field path the warning belongs to, for display next to the control. */
  field: string;
  message: string;
}

const STAGE_OFF_EFFECTS: Partial<Record<StageName, string>> = {
  plan: 'The ticket body becomes the plan.',
  breakdown:
    'The ticket runs as one subtask whose description is the plan. Acceptance criteria come from an "Acceptance criteria" section of the ticket if present.',
  tests: 'The implement stage is told to write the tests, and verify-green runs the changed test files or typecheck only.',
  kbBuild: 'Tickets with no KB doc are planned without one.',
  kbUpdate: 'The KB-update step is skipped.',
  review: 'The review step is skipped.',
};

/** Stage-dependency warnings shown when a dependent stage is disabled (F2). */
export function stageWarnings(settings: ProjectSettings): Warning[] {
  const warnings: Warning[] = [];
  for (const [name, effect] of Object.entries(STAGE_OFF_EFFECTS)) {
    if (!settings.stages[name as StageName].enabled) warnings.push({ field: `settings.stages.${name}.enabled`, message: effect });
  }
  return warnings;
}
