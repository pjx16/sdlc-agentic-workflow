import { Injectable } from '@nestjs/common';
import { DEFAULT_GLOBAL_SETTINGS, GlobalSettingsSchema, ProjectSettingsSchema, type ModelAlias, type StageName } from '@sdlc/shared';
import type { FixReason, Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentRunner, type StageRequest, type StageResult } from '../agent-runner/agent-runner';
import type { StageInputs } from '../agent-runner/context-builder';
import { WorkerConfig } from '../worker-config';

export interface LaunchOptions {
  workspacePath?: string;
  round?: number;
  reason?: FixReason;
  subtaskId?: string;
  validate?: StageRequest['validate'];
}

/** Builds a stage request from the ticket's project settings and the global settings, then runs it. */
@Injectable()
export class StageLauncher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    private readonly runner: AgentRunner,
  ) {}

  /** The workspace of a ticket (it exists once the NEW step has run). */
  workspaceOf(ticket: Pick<Ticket, 'projectId' | 'key'>): string {
    return this.config.workspacePath(ticket.projectId, ticket.key);
  }

  async launch(ticket: Ticket, stage: StageName, inputs: StageInputs, opts: LaunchOptions = {}): Promise<StageResult> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const global = await this.global();
    const stageSettings = settings.stages[stage];
    return this.runner.run({
      projectId: project.id,
      ticketId: ticket.id,
      subtaskId: opts.subtaskId,
      stage,
      reason: opts.reason,
      round: opts.round,
      stack: project.stack,
      claudeMdMode: project.claudeMdMode,
      modelAlias: stageSettings.model as ModelAlias,
      modelAliases: global.modelAliases,
      maxTurns: stageSettings.maxTurns,
      stageTimeoutMin: global.stageTimeoutMin,
      inputs,
      workspacePath: opts.workspacePath ?? this.workspaceOf(ticket),
      validate: opts.validate,
    });
  }

  private async global() {
    const row = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (!row) return DEFAULT_GLOBAL_SETTINGS;
    return GlobalSettingsSchema.parse({ stageTimeoutMin: row.stageTimeoutMin, modelAliases: row.modelAliases });
  }
}
