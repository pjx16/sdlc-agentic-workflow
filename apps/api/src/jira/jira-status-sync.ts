import { Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema, type TicketStatus } from '@sdlc/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { TransitionListener, TransitionResult } from '../state/state-machine.service';
import { JiraClients } from './jira-clients';

/**
 * Applies the project's `jiraStatusMap` after a transition (F15; REST directly, MCP through a jiraSync stage). The outcome is stored on the
 * StateTransition row (`jiraSyncResult`, `jiraStatusApplied`, `jiraSyncError`) and shown as a warning when it
 * failed; it never throws, so a Jira problem can never block the pipeline. (MCP mode uses a jiraSync stage, milestone 11.)
 */
@Injectable()
export class JiraStatusSync implements TransitionListener {
  private readonly logger = new Logger(JiraStatusSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: JiraClients,
  ) {}

  async onTransition({ ticket, transition }: TransitionResult): Promise<void> {
    if (ticket.source !== 'jira' || !ticket.externalKey) return;
    const project = await this.prisma.project.findUnique({ where: { id: ticket.projectId } });
    if (!project || (project.jiraMode !== 'rest' && project.jiraMode !== 'mcp')) return;
    // MCP mode needs the worker's jiraSync stage; a transition made in the API is picked up by the worker's sweep.
    if (project.jiraMode === 'mcp' && !this.clients.hasMcp()) return;

    const settings = ProjectSettingsSchema.parse(project.settings);
    const target = settings.jiraStatusMap[ticket.status as TicketStatus];
    if (!target || !settings.jiraWriteBack.transitions) return;

    try {
      await (await this.clients.forMode(project.jiraMode)).transition(ticket.externalKey, target);
      await this.prisma.stateTransition.update({ where: { id: transition.id }, data: { jiraStatusApplied: target, jiraSyncResult: 'applied', jiraSyncError: null } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Jira move of ${ticket.key} to "${target}" failed: ${message}`);
      await this.prisma.stateTransition
        .update({ where: { id: transition.id }, data: { jiraStatusApplied: target, jiraSyncResult: 'failed', jiraSyncError: message.slice(0, 500) } })
        .catch(() => undefined);
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'jira', message: `Jira move to "${target}" failed: ${message}`.slice(0, 500) } }).catch(() => undefined);
    }
  }

  /**
   * MCP mode: moves made in the API process (approvals) could not run a jiraSync stage there. The worker calls this to apply the mapped status
   * for tickets whose latest transition is still unsynced (within the last day). Returns how many tickets it handled.
   */
  async sweep(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - 24 * 3600_000);
    const tickets = await this.prisma.ticket.findMany({
      where: { source: 'jira', externalKey: { not: null }, project: { enabled: true, jiraMode: 'mcp' }, transitions: { some: { at: { gte: since }, jiraSyncResult: 'none' } } },
      include: { transitions: { orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 1 } },
      orderBy: { createdAt: 'asc' },
    });
    let handled = 0;
    for (const { transitions, ...ticket } of tickets) {
      const latest = transitions[0];
      if (!latest || latest.jiraSyncResult !== 'none' || latest.at < since) continue;
      await this.onTransition({ ticket, transition: latest } as TransitionResult);
      handled++;
    }
    return handled;
  }
}
