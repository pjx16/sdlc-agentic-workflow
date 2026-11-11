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
