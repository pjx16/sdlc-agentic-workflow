import { z } from 'zod';
import type { StageName } from './enums';

/** BUILD_PLAN 6.5: every stage returns this envelope. */
export const ENVELOPE_STATUSES = ['done', 'needs_input', 'blocked'] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

const text = z.string().min(1, 'must not be empty');
const textList = z.array(z.string());

export const PlanData = z.object({ planMarkdown: text, risks: textList, openQuestions: textList });

export const SubtaskData = z.object({
  seq: z.number().int().min(1),
  title: text,
  description: z.string(),
  acceptanceCriteria: z.array(text).min(1, 'at least one acceptance criterion'),
  files: textList,
  dependsOn: z.array(z.number().int().min(1)),
});
export const BreakdownData = z.object({ subtasks: z.array(SubtaskData).min(1, 'at least one subtask') });

export const TestsData = z.object({
  testFiles: z.array(text).min(1, 'at least one test file'),
  criteriaCovered: z.array(z.object({ criterion: text, test: text })),
});

export const ChangeData = z.object({ filesChanged: textList });

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const ReviewData = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(FINDING_SEVERITIES),
      file: text,
      line: z.number().int().nullable(),
      issue: text,
      rule: z.string(),
      fix: z.string(),
    }),
  ),
  previousFindings: z.array(z.object({ id: text, status: z.enum(['fixed', 'still_open']) })),
});

export const KbBuildData = z.object({ featureKey: text, isNew: z.boolean(), docPath: text, globs: textList });
export const KbUpdateData = z.object({ featureKey: text, docPath: text, changed: z.boolean() });

export const JiraIntakeData = z.object({
  tickets: z.array(
    z.object({
      key: text,
      summary: z.string(),
      description: z.string(),
      issuetype: z.string(),
      labels: textList,
      priority: z.string().nullable(),
    }),
  ),
});
export const JiraSyncData = z.object({ applied: z.boolean(), detail: z.string() });

export const STAGE_DATA = {
  kbBuild: KbBuildData,
  plan: PlanData,
  breakdown: BreakdownData,
  tests: TestsData,
  implement: ChangeData,
  fix: ChangeData,
  review: ReviewData,
  kbUpdate: KbUpdateData,
  jiraIntake: JiraIntakeData,
  jiraSync: JiraSyncData,
} as const satisfies Record<StageName, z.ZodType>;

export type StageData<S extends StageName> = z.infer<(typeof STAGE_DATA)[S]>;

export interface StageEnvelope<S extends StageName = StageName> {
  status: EnvelopeStatus;
  summary: string;
  question?: string;
  data?: StageData<S>;
}

/**
 * Full validation: the envelope, plus `data` for the stage when status is `done`, plus `question` when
 * status is `needs_input`. Use `zodFields` on the error for field-level messages.
 */
export function stageEnvelopeSchema(stage: StageName) {
  return z
    .object({
      status: z.enum(ENVELOPE_STATUSES),
      summary: z.string().max(400, 'must be at most 400 characters'),
      question: z.string().optional(),
      data: z.unknown().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.status === 'needs_input' && !value.question?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['question'], message: 'required when status is needs_input' });
      }
      if (value.status === 'done') {
        const parsed = STAGE_DATA[stage].safeParse(value.data);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['data', ...issue.path], message: issue.message });
        }
      }
    });
}

/** JSON Schema for `schema.json` (`--json-schema`): the envelope with the stage's `data` shape. */
export function stageJsonSchema(stage: StageName): Record<string, unknown> {
  const schema = z.object({
    status: z.enum(ENVELOPE_STATUSES),
    summary: z.string().max(400),
    question: z.string().optional(),
    data: STAGE_DATA[stage].optional(),
  });
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
