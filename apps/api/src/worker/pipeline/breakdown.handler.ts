import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, describeIssues, singleSubtask, validateBreakdown, type StageEnvelope, type SubtaskDraft } from '@sdlc/shared';
import { SubtasksService } from '../../subtasks/subtasks.service';
import type { Ticket } from '../../generated/prisma/client';
import type { Prisma } from '../../generated/prisma/client';
import { writeArtifact } from '../../common/artifacts';
import { PrismaService } from '../../prisma/prisma.service';
import { featureKeyOf, lookup } from '../kb/kb-index';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepHandler, StepOutcome } from './step-handler';

/**
 * BREAKDOWN (rows 7 and 8): run the `breakdown` stage (read-only workspace), validate the list with the orchestrator's rules
 * (a rejected list is a failed attempt), store it as the draft, and stop at the breakdown gate (F8).
 */
@Injectable()
export class BreakdownHandler implements StepHandler {
  readonly status = 'BREAKDOWN' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly subtasks: SubtasksService,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const maxSubtasks = settings.limits.maxSubtasks;

    if (!settings.stages.technicalDesign.enabled) {
      // "breakdown off: the ticket runs as one subtask whose description is the plan" (row 8).
      const only = singleSubtask(ticket, ticket.planMarkdown ?? ticket.body);
      return this.approve(ticket, [only], 'The breakdown stage is off: one subtask runs the whole plan');
    }

    const ws = this.launcher.workspaceOf(ticket);
    const { match } = await lookup(ws, project.kbDir, featureKeyOf(ticket));
    const rejection = await this.rejection(ticket);

    const result = await this.launcher.launch(
      ticket,
      'technicalDesign',
      {
        ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
        plan: ticket.planMarkdown ?? undefined,
        kbDoc: match?.content,
        maxSubtasks,
        ...(rejection ? { previousBreakdown: JSON.stringify(ticket.breakdownDraft, null, 2), rejectionNote: rejection } : {}),
      },
      {
        workspacePath: ws,
        // A rejected output counts as a failed attempt (BUILD_PLAN 6.8).
        validate: (envelope) => {
          const verdict = validateBreakdown(this.subtasksOf(envelope), { maxSubtasks });
          return verdict.ok ? null : describeIssues(verdict.issues);
        },
      },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'technicalDesign', result);

    const verdict = validateBreakdown(this.subtasksOf(result.envelope), { maxSubtasks });
    if (!verdict.ok) return { kind: 'hold', reason: 'needs_help', note: describeIssues(verdict.issues).slice(0, 500), stageRunId: result.stageRunId };
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { breakdownDraft: verdict.subtasks as unknown as Prisma.InputJsonValue } });
    await writeArtifact(this.prisma, ticket.id, 'breakdown', { subtasks: verdict.subtasks, filesByOrder: (result.envelope.data as { filesByOrder?: string[] } | undefined)?.filesByOrder ?? [] }, result.stageRunId).catch(() => undefined);

    // With the gate off the subtasks are created at once (row 8); otherwise the ticket waits for approval (row 7).
    if (!settings.gates.breakdown) return this.approve(ticket, verdict.subtasks, 'Breakdown stored; the breakdown gate is off', result.stageRunId);
    return { kind: 'transition', to: 'AWAITING_BREAKDOWN_APPROVAL', reason: `Breakdown ready for approval (${verdict.subtasks.length} subtasks)`, stageRunId: result.stageRunId };
  }

  private subtasksOf(envelope: StageEnvelope): SubtaskDraft[] | unknown {
    return (envelope.data as { subtasks?: unknown } | undefined)?.subtasks;
  }

  /** The developer's note when the latest move into BREAKDOWN was a rejection at the breakdown gate (row 10). */
  private async rejection(ticket: Ticket): Promise<string | null> {
    if (!ticket.breakdownDraft) return null;
    const last = await this.prisma.stateTransition.findFirst({ where: { ticketId: ticket.id, toStatus: 'BREAKDOWN' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    if (last?.kind === 'rerun') return last.note ?? 'The developer asked for the breakdown to be redone.';
    return last?.fromStatus === 'AWAITING_BREAKDOWN_APPROVAL' && last.reason ? last.reason : null;
  }

  /** Creates the Subtask rows (and Jira sub-tasks when write-back is on) and goes straight to IN_PROGRESS. */
  private async approve(ticket: Ticket, drafts: SubtaskDraft[], reason: string, stageRunId?: string): Promise<StepOutcome> {
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { breakdownDraft: drafts as unknown as Prisma.InputJsonValue } });
    await this.subtasks.create(ticket.id, drafts);
    await this.subtasks.publishToJira(ticket.id);
    return { kind: 'transition', to: 'IN_PROGRESS', reason, stageRunId };
  }
}
