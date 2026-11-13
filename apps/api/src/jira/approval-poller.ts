import { Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema, approvalTarget, validateBreakdown, type SubtaskDraft, type TicketStatus } from '@sdlc/shared';
import type { Project } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine } from '../state/state-machine.service';
import { SubtasksService } from '../subtasks/subtasks.service';
import { JiraNotConfiguredError, JiraClients } from './jira-clients';
import { JiraUnavailableError } from './jira-client';

/**
 * Inbound approval (F15): for tickets awaiting plan or breakdown approval, read the issue's
 * Jira status; if it equals the configured approval status, approve. Any other manual Jira change is ignored.
 */
@Injectable()
export class ApprovalPoller {
  private readonly logger = new Logger(ApprovalPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: JiraClients,
    private readonly states: StateMachine,
    private readonly subtasks: SubtasksService,
  ) {}

  /** Returns how many tickets were approved. Throws JiraUnavailableError if Jira is down (the loop pauses intake). */
  async check(only?: (project: Project) => boolean): Promise<number> {
    const tickets = await this.prisma.ticket.findMany({
      where: { source: 'jira', externalKey: { not: null }, status: { in: ['AWAITING_PLAN_APPROVAL', 'AWAITING_BREAKDOWN_APPROVAL'] }, project: { enabled: true, jiraMode: 'rest' } },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    let approved = 0;
    for (const ticket of tickets.filter((t) => !only || only(t.project))) {
      const approvals = ProjectSettingsSchema.parse(ticket.project.settings).jiraApprovalStatuses;
      if (!approvals.plan && !approvals.breakdown) continue;
      try {
        const issue = await (await this.clients.forRest()).readStatus(ticket.externalKey as string);
        const { status } = issue;
        const next = approvalTarget(ticket.status as TicketStatus, status, approvals);
        if (!next) continue;
        // Plan approval: developer edits to the title and description made in Jira reach the breakdown stage (F7).
        if (next === 'BREAKDOWN') await this.prisma.ticket.update({ where: { id: ticket.id }, data: { title: issue.summary || undefined, body: issue.description } });
        // Breakdown approval: the proposed subtasks become Subtask rows, exactly as a dashboard approval does (F8).
        if (next === 'IN_PROGRESS') {
          const verdict = validateBreakdown(ticket.breakdownDraft, { maxSubtasks: ProjectSettingsSchema.parse(ticket.project.settings).limits.maxSubtasks });
          if (!verdict.ok) {
            this.logger.warn(`Breakdown of ${ticket.key} cannot be approved from Jira: its proposed list is not valid`);
            continue;
          }
          await this.subtasks.create(ticket.id, verdict.subtasks as SubtaskDraft[]);
          await this.subtasks.publishToJira(ticket.id);
        }
        await this.states.transition(ticket.id, next, 'jira', `approved in Jira (status "${status}")`);
        approved++;
      } catch (err) {
        if (err instanceof JiraUnavailableError || err instanceof JiraNotConfiguredError) throw err;
        // One bad ticket (deleted issue, no permission) must not stop the others.
        this.logger.warn(`Approval check for ${ticket.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return approved;
  }
}
