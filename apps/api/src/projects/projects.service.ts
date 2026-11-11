import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes, ProjectInputSchema, deepMerge, type ProjectInput } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { Prisma } from '../generated/prisma/client';
import { JiraClients } from '../jira/jira-clients';
import { PrismaService } from '../prisma/prisma.service';
import { type ProjectDto, toDto, toInput } from './project.dto';

const nameTaken = () =>
  new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { name: 'a project with this name already exists' });

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraClients,
  ) {}

  async list(): Promise<ProjectDto[]> {
    return (await this.prisma.project.findMany({ orderBy: { createdAt: 'asc' } })).map(toDto);
  }

  async get(id: string): Promise<ProjectDto> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Project not found');
    return toDto(project);
  }

  async create(body: unknown): Promise<ProjectDto> {
    const input = parseBody(ProjectInputSchema, body);
    try {
      return toDto(await this.prisma.project.create({ data: this.data(input) }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameTaken();
      throw err;
    }
  }

  /** PATCH: merge the body into the stored project, then validate the whole result. */
  async update(id: string, body: unknown): Promise<ProjectDto> {
    const current = await this.get(id);
    const input = parseBody(ProjectInputSchema, deepMerge(toInput(current), body ?? {}));
    // The mirror must follow the repository and base branch, so a change re-queues the clone.
    const mirrorChanged = input.repoUrl !== current.repoUrl || input.baseBranch !== current.baseBranch;
    try {
      const updated = await this.prisma.project.update({
        where: { id },
        data: { ...this.data(input), ...(mirrorChanged ? { mirrorStatus: 'pending', mirrorError: null } : {}) },
      });
      return toDto(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameTaken();
      throw err;
    }
  }

  /** GET /projects/:id/jira/statuses: Jira status names for the mapping dropdown (REST mode). */
  async jiraStatuses(id: string): Promise<string[]> {
    const project = await this.get(id);
    if (project.jiraMode !== 'rest') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'Jira statuses can only be listed when the project is in REST mode');
    }
    if (!project.jiraProjectKey) {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'Set the Jira project key first');
    }
    try {
      return await this.jira.forRest().listStatuses(project.jiraProjectKey);
    } catch (err) {
      throw new ApiException(HttpStatus.BAD_GATEWAY, ErrorCodes.jiraError, err instanceof Error ? err.message : 'Jira request failed');
    }
  }

  /** DELETE is a soft disable: tickets and history stay. */
  async disable(id: string): Promise<ProjectDto> {
    await this.get(id);
    return toDto(await this.prisma.project.update({ where: { id }, data: { enabled: false } }));
  }

  async retryMirror(id: string): Promise<ProjectDto> {
    const project = await this.get(id);
    if (project.mirrorStatus !== 'failed') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The mirror can only be retried when its status is failed');
    }
    return toDto(await this.prisma.project.update({ where: { id }, data: { mirrorStatus: 'pending', mirrorError: null } }));
  }

  private data(input: ProjectInput) {
    return {
      name: input.name,
      repoUrl: input.repoUrl,
      baseBranch: input.baseBranch,
      stack: input.stack,
      installCmd: input.installCmd,
      typecheckCmd: input.typecheckCmd,
      testCmdTemplate: input.testCmdTemplate,
      kbDir: input.kbDir,
      claudeMdMode: input.claudeMdMode,
      jiraMode: input.jiraMode,
      jiraProjectKey: input.jiraProjectKey ?? null,
      jiraJql: input.jiraJql ?? null,
      localKeyPrefix: input.localKeyPrefix,
      enabled: input.enabled,
      settings: input.settings as unknown as Prisma.InputJsonValue,
    };
  }
}
