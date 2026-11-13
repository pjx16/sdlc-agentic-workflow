import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { DEFAULT_GLOBAL_SETTINGS, GlobalSettingsSchema, ProjectSettingsSchema, type ModelAlias, type StageName, type TicketStatus } from '@sdlc/shared';
import type { FixReason, Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentRunner, type StageRequest, type StageResult } from '../agent-runner/agent-runner';
import type { StageInputs } from '../agent-runner/context-builder';
import { HARDENING_FLAGS } from '../git/git-runner';
import { STAGE_WORKSPACE } from '../agent-runner/stage-config';
import { WorkerConfig } from '../worker-config';

const exec = promisify(execFile);

/** The ticket state each stage runs in. */
const STATE_OF_STAGE: Partial<Record<StageName, TicketStatus>> = { featureMap: 'KB', kbBuild: 'KB', solutionDesign: 'PLANNING', bugInvestigation: 'PLANNING', technicalDesign: 'BREAKDOWN', tests: 'IN_PROGRESS', implement: 'IN_PROGRESS', fix: 'IN_PROGRESS', prReview: 'REVIEW', qualityReview: 'REVIEW', securityReview: 'REVIEW', kbUpdate: 'KB_UPDATE', ciTriage: 'KB_UPDATE' };

/** HEAD of a workspace, or null when it is not a repository (yet). */
export async function headOf(workspace: string): Promise<string | null> {
  try {
    return (await exec('git', [...HARDENING_FLAGS, 'rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim() || null;
  } catch {
    return null;
  }
}

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
    const answered = await this.prisma.supportTicket.findMany({ where: { ticketId: ticket.id, stage, kind: 'question', status: 'answered' }, orderBy: { createdAt: 'asc' } });
    const qa = answered.map((q) => ({ question: q.body, answer: q.response ?? '' }));
    const rerun = await this.rerunInput(ticket, stage, inputs);
    const workspacePath = opts.workspacePath ?? this.workspaceOf(ticket);
    // A stage that writes code starts from the current branch head: the range from here to the head after its commit is what a rerun reverts (BUILD_PLAN v1 6.8).
    const startSha = STAGE_WORKSPACE[stage] === 'rw' ? await headOf(workspacePath) : null;
    const result = await this.runner.run({
      projectId: project.id,
      ticketId: ticket.id,
      ticketKey: ticket.key,
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
      inputs: { ...inputs, ...(qa.length > 0 ? { qa } : {}), ...(rerun ? { rerun } : {}) },
      workspacePath,
      validate: opts.validate,
    });
    // No commit yet: the run covers an empty range. The commit that follows (WorkspaceService.commit) moves `endSha` forward.
    if (startSha && 'stageRunId' in result && result.stageRunId) {
      await this.prisma.stageRun.updateMany({ where: { id: result.stageRunId }, data: { startSha, endSha: startSha } }).catch(() => undefined);
    }
    return result;
  }

  /** The note of a rerun that sent the ticket back to this stage's state, until the ticket moves on (BUILD_PLAN v1 6.8). Plan and breakdown carry their own. */
  private async rerunInput(ticket: Ticket, stage: StageName, inputs: StageInputs): Promise<StageInputs['rerun'] | undefined> {
    const state = STATE_OF_STAGE[stage];
    if (!state || inputs.rejectionNote || inputs.rerun || stage === 'solutionDesign' || stage === 'bugInvestigation' || stage === 'technicalDesign') return undefined;
    const last = await this.prisma.stateTransition.findFirst({ where: { ticketId: ticket.id, toStatus: state }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    if (!last || last.kind !== 'rerun') return undefined;
    return { note: last.note ?? 'The developer asked for this stage to be redone.' };
  }

  private async global() {
    const row = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (!row) return DEFAULT_GLOBAL_SETTINGS;
    return GlobalSettingsSchema.parse({ stageTimeoutMin: row.stageTimeoutMin, modelAliases: row.modelAliases });
  }
}
