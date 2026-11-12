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
