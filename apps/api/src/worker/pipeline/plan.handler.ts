import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { writeArtifact } from '../../common/artifacts';
import { SupportRaiser } from '../../support/support-raiser';
import { ProjectSettingsSchema, type StageEnvelope } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { jiraMarker } from '../../jira/jira-client';
import { JiraClients } from '../../jira/jira-clients';
import { PrismaService } from '../../prisma/prisma.service';
import { featureKeyOf, lookup } from '../kb/kb-index';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepHandler, StepOutcome } from './step-handler';

interface PlanData {
  planMarkdown: string;
  risks: string[];
  openQuestions: string[];
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

/** The plan as one markdown text: the plan itself, then its risks and open questions, so the developer sees them at the gate. */
export function composePlan(data: PlanData): string {
  const parts = [data.planMarkdown.trim()];
  if (data.risks.length > 0) parts.push(`## Risks\n\n${bullets(data.risks)}`);
  if (data.openQuestions.length > 0) parts.push(`## Open questions\n\n${bullets(data.openQuestions)}`);
  return parts.join('\n\n');
}

/**
 * PLANNING (rows 3 and 4): run the `plan` stage (read-only workspace), save the plan on the ticket, post it to Jira when
 * write-back is on, and go to the plan gate, or straight to breakdown when the gate (or the stage) is off (F7).
 */
@Injectable()
export class PlanHandler implements StepHandler {
  readonly status = 'PLANNING' as const;
  private readonly logger = new Logger(PlanHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly jira: JiraClients,
    @Optional() raiser?: SupportRaiser,
    @Optional() @Inject(OrchestratorService) private readonly orchestrator?: OrchestratorService,
  ) {
    this.raiser = raiser ?? new SupportRaiser(prisma);
  }

  private readonly raiser: SupportRaiser;

  async run(ticket: Ticket): Promise<StepOutcome> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);

    const planStage = ticket.kind === 'bug' ? 'bugInvestigation' : 'solutionDesign';
    if (!settings.stages[planStage].enabled) {
      // "plan off: the ticket body becomes the plan".
      await this.prisma.ticket.update({ where: { id: ticket.id }, data: { planMarkdown: ticket.body || ticket.title } });
      return { kind: 'transition', to: 'BREAKDOWN', reason: 'The plan stage is off: the ticket body is the plan' };
    }

    // A chore with the plan gate off may skip planning, but only when the orchestrator says so (BUILD_PLAN v1 6.11).
    if (ticket.kind === 'chore' && !settings.gates.plan && this.orchestrator && (await this.prisma.stageArtifact.count({ where: { ticketId: ticket.id, stage: 'plan' } })) === 0) {
      const pick = await this.orchestrator.choose(ticket, 'chore_plan', [{ kind: 'plan', to: 'plan', label: 'Write a plan' }, { kind: 'skip_plan', to: 'skip_plan', label: 'Skip planning: the ticket body is the plan' }], 'plan', `Title: ${ticket.title}. Description length: ${(ticket.body ?? '').length} characters.`);
      if (pick.option.kind === 'skip_plan') {
        const plan = ticket.body || ticket.title;
        await this.prisma.ticket.update({ where: { id: ticket.id }, data: { planMarkdown: plan } });
        await writeArtifact(this.prisma, ticket.id, 'plan', { planMarkdown: plan }, null).catch(() => undefined);
        return { kind: 'transition', to: 'BREAKDOWN', reason: `Planning was skipped for this chore: ${pick.reason}` };
      }
    }

    const ws = this.launcher.workspaceOf(ticket);
    const { match } = await lookup(ws, project.kbDir, featureKeyOf(ticket));
    const rejection = await this.rejection(ticket);

    const result = await this.launcher.launch(
      ticket,
      planStage,
      {
        ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
        kbDoc: match?.content,
        ...(rejection ? { previousPlan: ticket.planMarkdown ?? undefined, rejectionNote: rejection } : {}),
      },
      { workspacePath: ws },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, planStage, result);

    const plan = composePlan((result.envelope as StageEnvelope).data as PlanData);
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { planMarkdown: plan } });
    await writeArtifact(this.prisma, ticket.id, 'plan', { planMarkdown: plan }, result.stageRunId).catch(() => undefined);
    await this.raiseOpenQuestions(ticket, (result.envelope as StageEnvelope).data as PlanData, result.stageRunId).catch((err: unknown) => this.logger.warn(`Raising the open questions of ${ticket.key} failed: ${err instanceof Error ? err.message : String(err)}`));
    // With Confluence configured the plan page is published by the plan page sync, which also links it on Jira (and posts the full text if Confluence fails).
    if (!settings.confluence?.parentPageId) await this.commentOnJira(ticket, project.jiraMode, settings.jiraWriteBack.comments, plan);

    return settings.gates.plan
      ? { kind: 'transition', to: 'AWAITING_PLAN_APPROVAL', reason: 'Plan ready for approval', stageRunId: result.stageRunId }
      : { kind: 'transition', to: 'BREAKDOWN', reason: 'Plan stored; the plan gate is off', stageRunId: result.stageRunId };
  }

  /**
   * Each open question of the plan becomes a support ticket that does not block: the plan went ahead with its own default (BUILD_PLAN v1 6.5).
   * A new plan replaces the questions of the old one.
   */
  private async raiseOpenQuestions(ticket: Ticket, plan: PlanData, stageRunId: string): Promise<void> {
    await this.raiser.close({ ticketId: ticket.id, kind: 'open_question' }, 'dismissed', 'system', 'Replaced by a new plan');
    for (const [i, question] of plan.openQuestions.entries()) {
      await this.raiser.raise({ kind: 'open_question', ticketId: ticket.id, stageRunId, stage: 'plan', title: question.slice(0, 120), body: question, dedupeKey: `open_question:${ticket.id}:${stageRunId}:${i}` });
    }
  }

  /** The developer's note, when the latest move into PLANNING was a rejection at the plan gate (row 6). */
  private async rejection(ticket: Ticket): Promise<string | null> {
    if (!ticket.planMarkdown) return null;
    const last = await this.prisma.stateTransition.findFirst({ where: { ticketId: ticket.id, toStatus: 'PLANNING' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    // A rejection at the gate (its reason is the note) or a rerun from further on (its note); either way the stage sees the previous plan.
    if (last?.kind === 'rerun') return last.note ?? 'The developer asked for the plan to be redone.';
    return last?.fromStatus === 'AWAITING_PLAN_APPROVAL' && last.reason ? last.reason : null;
  }

  /** Posts the plan to the Jira issue (REST). A Jira problem never blocks the pipeline. */
  private async commentOnJira(ticket: Ticket, jiraMode: string, enabled: boolean, plan: string): Promise<void> {
    if (!enabled || jiraMode !== 'rest' || ticket.source !== 'jira' || !ticket.externalKey) return;
    try {
      await (await this.jira.forRest()).comment(ticket.externalKey, `## Plan for ${ticket.key}\n\n${plan}`, jiraMarker(ticket.key, 'plan', plan));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Posting the plan to ${ticket.externalKey} failed: ${message}`);
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'jira', message: `Could not post the plan to Jira: ${message}`.slice(0, 500) } });
    }
  }
}
