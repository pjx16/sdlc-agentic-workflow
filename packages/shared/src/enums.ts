export const PROJECT_STACKS = ['ts_node', 'nestjs', 'nextjs'] as const;
export type ProjectStack = (typeof PROJECT_STACKS)[number];

export const CLAUDE_MD_MODES = ['ours', 'theirs', 'both'] as const;
export type ClaudeMdMode = (typeof CLAUDE_MD_MODES)[number];

export const JIRA_MODES = ['rest', 'off'] as const;
export type JiraMode = (typeof JIRA_MODES)[number];

export const MIRROR_STATUSES = ['pending', 'ok', 'failed'] as const;
export type MirrorStatus = (typeof MIRROR_STATUSES)[number];

export const TICKET_STATUSES = [
  'NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL',
  'IN_PROGRESS', 'REVIEW', 'KB_UPDATE', 'AWAITING_CI', 'IN_HUMAN_REVIEW', 'DONE', 'ON_HOLD', 'FAILED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STAGE_NAMES = [
  'kbBuild', 'plan', 'breakdown', 'tests', 'implement', 'fix', 'review', 'kbUpdate', 'assist',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];
