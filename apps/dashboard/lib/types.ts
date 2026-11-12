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

export interface IntakeStatusView {
  mode: 'rest' | 'mcp';
  at: string | null;
  projects: number;
  waiting: number;
  created: number;
  seen: number;
  error: string | null;
  skipped: string | null;
}

/** What the worker last reported; `online` comes from its heartbeat. */
export interface WorkerStatusView {
  online: boolean;
  heartbeatAt: string;
  tickOutcome: string;
  tickDetail: string | null;
  intake: IntakeStatusView[];
}

export interface RecentEvent {
  id: string;
  at: string;
  type: string;
  message: string;
  ticketId: string | null;
  ticketKey: string | null;
}

export interface SystemView {
  settings: GlobalSettingsView;
  worker?: WorkerStatusView | null;
  recentEvents?: RecentEvent[];
  runningStage: { id: string; stage: string; model: string; projectId: string; ticketId: string | null; startedAt: string | null } | null;
  usage: { at: string; fiveHourPct: number | null; sevenDayPct: number | null; status: string | null; resetsAt: string | null; source: string } | null;
}

export interface UsageSnapshotView {
  id: string;
  at: string;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  status: string | null;
  resetsAt: string | null;
  source: string;
  windowTokens: number;
}

export interface UsageSummaryView {
  tokens: { stage: string; model: string; tokens: number; runs: number }[];
  suggestedCalibration: number | null;
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

export interface SupportQueryView {
  id: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  stage: string;
  question: string;
  answer: string | null;
  status: 'open' | 'answered';
  createdAt: string;
  answeredAt: string | null;
}

export type MetricsRange = '24h' | '7d' | '30d';

export interface MetricsSummary {
  range: MetricsRange;
  ticketsDone: number;
  firstPassRate: number | null;
  tokensInWindow: number;
  queueLength: number;
}

export interface MetricsUsage {
  range: MetricsRange;
  thresholdPct: number;
  thresholdWeeklyPct: number;
  series: { at: string; fiveHourPct: number | null; sevenDayPct: number | null; status: string | null }[];
  pauses: { at: string; message: string }[];
}

export interface MetricsTokens {
  range: MetricsRange;
  groupBy: 'stage' | 'model';
  keys: string[];
  days: { day: string; total: number; groups: Record<string, number> }[];
}

export interface MetricsMerged {
  range: MetricsRange;
  days: { day: string; merged: number; additions: number; deletions: number }[];
  totals: { merged: number; additions: number; deletions: number; withoutLineData: number };
}

export interface MetricsQuality {
  range: MetricsRange;
  firstPassRate: number | null;
  avgFixRounds: number | null;
  avgReviewRounds: number | null;
  findingsBySeverity: { severity: string; count: number }[];
}

export interface MetricsDurations {
  range: MetricsRange;
  stages: { stage: string; runs: number; medianSeconds: number }[];
}

export interface StateCount {
  status: string;
  count: number;
}
