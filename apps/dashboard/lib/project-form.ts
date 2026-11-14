import {
  DEFAULT_PROJECT_SETTINGS, STACK_PREFILLS, STAGE_NAMES, TICKET_STATUSES,
  type ProjectStack,
} from '@sdlc/shared';
import { splitLines, stringifyNumbers, toNumber, type FormValues } from './form';
import type { ProjectView } from './types';

const NUMERIC_PATHS = [
  ...STAGE_NAMES.map((s) => `settings.stages.${s}.maxTurns`),
  'settings.pr.ciTimeoutMin',
  'settings.limits.maxSubtasks',
  'settings.limits.maxTestFixRounds',
  'settings.limits.maxReviewRounds',
  'settings.limits.kbDocMaxLines',
  'settings.limits.reviewMaxDiffLines',
  'settings.loopLimits.ciFix',
  'settings.loopLimits.userRerun',
  'settings.loopLimits.orchestratorReplan',
];

export function initialValues(project?: ProjectView): FormValues {
  if (project) {
    return {
      name: project.name,
      repoUrl: project.repoUrl,
      baseBranch: project.baseBranch,
      stack: project.stack,
      installCmd: project.installCmd,
      typecheckCmd: project.typecheckCmd,
      testCmdTemplate: project.testCmdTemplate,
      kbDir: project.kbDir,
      claudeMdMode: project.claudeMdMode,
      jiraMode: project.jiraMode,
      jiraProjectKey: project.jiraProjectKey ?? '',
      jiraJql: project.jiraJql ?? '',
      localKeyPrefix: project.localKeyPrefix,
      enabled: project.enabled,
      settings: formSettings(project.settings),
    };
  }
  return {
    name: '',
    repoUrl: '',
    baseBranch: 'dev',
    stack: 'ts_node',
    ...STACK_PREFILLS.ts_node,
    kbDir: 'docs/kb',
    claudeMdMode: 'both',
    jiraMode: 'off',
    jiraProjectKey: '',
    jiraJql: '',
    localKeyPrefix: '',
    enabled: true,
    settings: formSettings(DEFAULT_PROJECT_SETTINGS),
  };
}

function formSettings(settings: ProjectView['settings']): FormValues {
  const s = stringifyNumbers(structuredClone(settings)) as unknown as FormValues & {
    verify: { redInvalidPatterns: string[] | string };
    jiraStatusMap: Record<string, string | null>;
    jiraApprovalStatuses: Record<string, string | undefined>;
  };
  s.verify.redInvalidPatterns = settings.verify.redInvalidPatterns.join('\n');
  (s as unknown as { securityRiskPatterns: string }).securityRiskPatterns = (settings.securityRiskPatterns ?? []).join('\n');
  for (const status of TICKET_STATUSES) s.jiraStatusMap[status] = settings.jiraStatusMap[status] ?? '';
  s.jiraApprovalStatuses = { plan: settings.jiraApprovalStatuses.plan ?? '', breakdown: settings.jiraApprovalStatuses.breakdown ?? '' };
  return s;
}

/** Converts form text back into the API shape (numbers, string lists, empty-to-null). */
export function toPayload(values: FormValues): Record<string, unknown> {
  const out = structuredClone(values) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const path of NUMERIC_PATHS) {
    const keys = path.split('.');
    const last = keys.pop() as string;
    const parent = keys.reduce((o, k) => o?.[k], out);
    if (parent && last in parent) parent[last] = toNumber(parent[last]);
  }
  const s = out.settings;
  s.verify.redInvalidPatterns = splitLines(String(s.verify.redInvalidPatterns ?? ''));
  s.securityRiskPatterns = splitLines(String(s.securityRiskPatterns ?? ''));
  for (const status of TICKET_STATUSES) {
    const v = String(s.jiraStatusMap[status] ?? '').trim();
    s.jiraStatusMap[status] = v === '' ? null : v;
  }
  for (const key of ['plan', 'breakdown']) {
    const v = String(s.jiraApprovalStatuses[key] ?? '').trim();
    if (v === '') delete s.jiraApprovalStatuses[key];
    else s.jiraApprovalStatuses[key] = v;
  }
  if (String(out.localKeyPrefix ?? '').trim() === '') delete out.localKeyPrefix;
  return out;
}

/** Re-prefills the three commands when the stack changes, unless the user has customised them. */
export function applyStackChange(values: FormValues, previous: ProjectStack, next: ProjectStack): FormValues {
  const prev = STACK_PREFILLS[previous];
  const fill = STACK_PREFILLS[next];
  const out: FormValues = { ...values, stack: next };
  for (const key of ['installCmd', 'typecheckCmd', 'testCmdTemplate'] as const) {
    const current = String(values[key] ?? '');
    if (current === '' || current === prev[key]) out[key] = fill[key];
  }
  return out;
}
