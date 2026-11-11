import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import type { ApprovalPoller } from '../../jira/approval-poller';
import type { JiraStatusSync } from '../../jira/jira-status-sync';
import { PrismaService } from '../../prisma/prisma.service';
import type { SubtasksService } from '../../subtasks/subtasks.service';
import type { Housekeeper } from '../loop/worker-loop';
import { IntakePoller } from './intake-poller';

/**
 * MCP-mode Jira work (F3, F15). Every read and write is a stage run, so all of it stops while the pipeline is paused, and the reads follow
 * `intake.mcpPollIntervalSec`. Intake: each project in MCP mode is polled every `intake.mcpPollIntervalSec` (default 900; every poll costs a stage run),
 * and not at all while the pipeline is paused. The intake switch and Jira backoff are the same as in REST mode.
 */
@Injectable()
export class McpIntake implements Housekeeper {
  readonly name = 'mcp-intake';
  /** Checked often; each project has its own, longer interval. */
  readonly intervalMs = 30_000;
  private readonly last = new Map<string, number>();
  /** A failing publish is a stage run each time, so a ticket is tried again at most every quarter of an hour. */
  private readonly published = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: IntakePoller,
    private readonly now: () => number = () => Date.now(),
    private readonly approvals?: Pick<ApprovalPoller, 'check'>,
    private readonly subtasks?: Pick<SubtasksService, 'publishToJira'>,
    private readonly statusSync?: Pick<JiraStatusSync, 'sweep'>,
  ) {}

  async check(): Promise<void> {
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (settings?.pipelinePaused) return;
    // Reads (intake and approvals) stop with the intake switch; the poll clock does not run while it is off.
    if (!settings?.intakePaused) {
      const t = this.now();
      const projects = await this.prisma.project.findMany({ where: { enabled: true, jiraMode: 'mcp' } });
      const due = new Set(
        projects
          .filter((project) => {
            const every = ProjectSettingsSchema.parse(project.settings).intake.mcpPollIntervalSec * 1000;
            const previous = this.last.get(project.id);
            if (previous !== undefined && t - previous < every) return false;
            this.last.set(project.id, t);
            return true;
          })
          .map((p) => p.id),
      );
      if (due.size > 0) {
        await this.intake.poll('mcp', (project) => due.has(project.id));
        await this.approvals?.check('mcp', (project) => due.has(project.id)).catch(() => undefined);
      }
    }
    await this.publishPendingSubtasks();
    await this.statusSync?.sweep().catch(() => undefined);
  }

  /** Sub-tasks of approved breakdowns that the API could not publish (it cannot run a jiraSync stage). */
  private async publishPendingSubtasks(): Promise<void> {
    if (!this.subtasks) return;
    const tickets = await this.prisma.ticket.findMany({
      where: { source: 'jira', externalKey: { not: null }, status: { in: ['IN_PROGRESS', 'REVIEW', 'KB_UPDATE', 'AWAITING_CI', 'IN_HUMAN_REVIEW'] }, project: { enabled: true, jiraMode: 'mcp' }, subtasks: { some: { externalKey: null } } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    for (const { id } of tickets) {
      const previous = this.published.get(id);
      if (previous !== undefined && this.now() - previous < 15 * 60_000) continue;
      this.published.set(id, this.now());
      await this.subtasks.publishToJira(id).catch(() => undefined);
    }
  }
}
