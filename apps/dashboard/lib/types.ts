import type { ProjectInput, ProjectSettings } from '@sdlc/shared';

/** A project as returned by the API. */
export type ProjectView = Omit<ProjectInput, 'settings' | 'jiraProjectKey' | 'jiraJql'> & {
  jiraProjectKey?: string;
  jiraJql?: string;
  id: string;
  mirrorStatus: 'pending' | 'ok' | 'failed';
  mirrorError: string | null;
  nextLocalNumber: number;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
};

/** GlobalSettings as returned by GET /system and PATCH /system/settings. */
export interface GlobalSettingsView {
  usageThresholdPct: number;
  usageThresholdWeeklyPct: number;
  calibratedWindowTokens: number | null;
  pollIntervalSec: number;
  stageTimeoutMin: number;
  verifyTimeoutSec: number;
  workspaceRetentionDays: number;
  logRetentionDays: number;
  modelAliases: { haiku: string; sonnet: string; opus: string };
  jiraMcp: { readTools: string[]; writeTools: string[] };
  pipelinePaused: boolean;
  pausedReason: string | null;
  resetsAt: string | null;
  usageIgnoredUntil: string | null;
  intakePaused: boolean;
}

export interface SystemView {
  settings: GlobalSettingsView;
}

export interface TicketListItem {
  id: string;
  projectId: string;
  projectName: string;
  key: string;
  source: 'jira' | 'paste';
  type: 'story' | 'bug' | 'tech';
  title: string;
  status: string;
  holdReason: string | null;
  holdFromStatus: string | null;
  updatedAt: string;
}

export interface TransitionView {
  id: string;
  at: string;
  fromStatus: string;
  toStatus: string;
  actor: string;
  reason: string | null;
  stageRunId: string | null;
  jiraStatusApplied: string | null;
  jiraSyncResult: 'none' | 'applied' | 'failed';
  jiraSyncError: string | null;
}

export interface RunView {
  id: string;
  stage: string;
  model: string;
  attempt: number;
  round: number;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  numTurns: number;
  error: string | null;
}

export interface TicketDetail extends TicketListItem {
  body: string;
  featureKey: string | null;
  externalKey: string | null;
  branch: string | null;
  prUrl: string | null;
  createdAt: string;
  stageRuns: RunView[];
}

export interface TicketWithPlan extends TicketDetail {
  planMarkdown: string | null;
}

export interface GuidelineNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: GuidelineNode[];
}

export interface SubtaskRow {
  id: string;
  seq: number;
  title: string;
  description: string;
  status: string;
  fixRounds: number;
  acceptanceCriteria: string[];
  files: string[];
  dependsOn: number[];
}

export interface TicketFull extends TicketWithPlan {
  breakdownDraft: import('@sdlc/shared').SubtaskDraft[] | null;
  subtasks: SubtaskRow[];
  maxSubtasks: number;
}
