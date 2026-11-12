import { z } from 'zod';
import { CLAUDE_MD_MODES, JIRA_MODES, PROJECT_STACKS, type ProjectStack } from './enums';
import { ProjectSettingsSchema, type Warning } from './project-settings';

export interface StackPrefill {
  installCmd: string;
  typecheckCmd: string;
  testCmdTemplate: string;
}

/** Editable, not enforced (BUILD_PLAN section 7). */
export const STACK_PREFILLS: Record<ProjectStack, StackPrefill> = {
  ts_node: { installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx vitest run {files}' },
  nestjs: { installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx jest {files}' },
  nextjs: { installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx vitest run {files}' },
};

/** First 4 letters of the name, upper-cased (section 7). Falls back to "PROJ" if the name has no letters. */
export function defaultLocalKeyPrefix(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
  return letters || 'PROJ';
}

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const ProjectInputSchema = z
  .object({
    name: z.string({ error: 'required' }).trim().min(1, 'required').max(100, 'must be at most 100 characters'),
    repoUrl: z
      .string({ error: 'required' })
      .trim()
      .min(1, 'required')
      .refine((v) => /^https:\/\/[^\s/]+\/\S+$/.test(v), 'must be an HTTPS repository URL'),
    baseBranch: z
      .string()
      .trim()
      .min(1, 'required')
      .refine((v) => !/\s/.test(v), 'must not contain spaces')
      .default('dev'),
    stack: z.enum(PROJECT_STACKS, { error: 'must be one of ts_node, nestjs, nextjs' }),
    installCmd: z.string().trim().default(''),
    typecheckCmd: z.string().trim().default(''),
    testCmdTemplate: z
      .string({ error: 'required' })
      .trim()
      .min(1, 'required')
      .refine((v) => v.includes('{files}'), 'must contain {files}'),
    kbDir: z
      .string()
      .trim()
      .min(1, 'required')
      .refine((v) => !v.startsWith('/') && !v.split('/').includes('..'), 'must be a relative path inside the repository')
      .default('docs/kb'),
    claudeMdMode: z.enum(CLAUDE_MD_MODES).default('both'),
    jiraMode: z.enum(JIRA_MODES).default('off'),
    jiraProjectKey: optionalText.refine((v) => v === undefined || /^[A-Z][A-Z0-9_]*$/.test(v), 'must be upper-case letters, digits or _'),
    jiraJql: optionalText,
    localKeyPrefix: optionalText.refine((v) => v === undefined || /^[A-Z0-9]{1,10}$/.test(v), 'must be 1 to 10 upper-case letters or digits'),
    enabled: z.boolean().default(true),
    settings: ProjectSettingsSchema.prefault({}),
  })
  .transform((p) => ({ ...p, localKeyPrefix: p.localKeyPrefix ?? defaultLocalKeyPrefix(p.name) }));

export type ProjectInput = z.infer<typeof ProjectInputSchema>;

/** Non-blocking warnings about a project's commands (F2: empty install or typecheck is skipped). */
export function commandWarnings(p: Pick<ProjectInput, 'installCmd' | 'typecheckCmd'>): Warning[] {
  const warnings: Warning[] = [];
  if (p.installCmd.trim() === '') warnings.push({ field: 'installCmd', message: 'Empty: the install step is skipped.' });
  if (p.typecheckCmd.trim() === '') warnings.push({ field: 'typecheckCmd', message: 'Empty: the typecheck step is skipped.' });
  return warnings;
}
