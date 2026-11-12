import { ProjectSettingsSchema, type ProjectInput, type ProjectSettings } from '@sdlc/shared';
import type { Project } from '../generated/prisma/client';

export interface ProjectDto extends Omit<ProjectInput, 'settings'> {
  id: string;
  mirrorStatus: 'pending' | 'ok' | 'failed';
  mirrorError: string | null;
  nextLocalNumber: number;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

export function toDto(p: Project): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    repoUrl: p.repoUrl,
    baseBranch: p.baseBranch,
    stack: p.stack,
    installCmd: p.installCmd,
    typecheckCmd: p.typecheckCmd,
    testCmdTemplate: p.testCmdTemplate,
    kbDir: p.kbDir,
    claudeMdMode: p.claudeMdMode,
    jiraMode: p.jiraMode,
    jiraProjectKey: p.jiraProjectKey ?? undefined,
    jiraJql: p.jiraJql ?? undefined,
    localKeyPrefix: p.localKeyPrefix,
    nextLocalNumber: p.nextLocalNumber,
    mirrorStatus: p.mirrorStatus,
    mirrorError: p.mirrorError,
    enabled: p.enabled,
    // Fills defaults for settings stored before a field existed.
    settings: ProjectSettingsSchema.parse(p.settings),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const READ_ONLY = ['id', 'mirrorStatus', 'mirrorError', 'nextLocalNumber', 'createdAt', 'updatedAt'];

/** The editable fields of a stored project, as the input schema expects them (used to merge PATCH bodies). */
export function toInput(dto: ProjectDto): Record<string, unknown> {
  return Object.fromEntries(Object.entries(dto).filter(([key]) => !READ_ONLY.includes(key)));
}
