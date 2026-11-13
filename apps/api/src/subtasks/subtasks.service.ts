import { Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema, type SubtaskDraft } from '@sdlc/shared';
import { JiraClients } from '../jira/jira-clients';
import type { Prisma, Subtask } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Creates the ordered Subtask rows of an approved breakdown (F8). */
@Injectable()
export class SubtasksService {
  private readonly logger = new Logger(SubtasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraClients,
  ) {}

  /**
   * Replaces the ticket's subtasks with the given (already validated) list, ordered by `seq`, all PENDING.
   * Replacing makes this safe to repeat, for example after a retry.
   */
  async create(ticketId: string, drafts: readonly SubtaskDraft[]): Promise<Subtask[]> {
    const ordered = [...drafts].sort((a, b) => a.seq - b.seq);
    return this.prisma.$transaction(async (tx) => {
      await tx.subtask.deleteMany({ where: { ticketId } });
      const rows: Subtask[] = [];
      for (const d of ordered) {
        rows.push(
          await tx.subtask.create({
            data: {
              ticketId,
              seq: d.seq,
              title: d.title,
              description: d.description,
              acceptanceCriteria: d.acceptanceCriteria as Prisma.InputJsonValue,
              files: d.files as Prisma.InputJsonValue,
              dependsOn: d.dependsOn as Prisma.InputJsonValue,
              status: 'PENDING',
            },
          }),
        );
      }
      await tx.event.create({ data: { ticketId, type: 'state', message: `Created ${rows.length} subtask(s)` } });
      return rows;
    });
  }

  /**
   * On approval, with `jiraWriteBack.createSubtasks` on (REST mode, a Jira ticket), creates one Jira sub-task per subtask
   * (issue type `jiraSubtaskTypeName`) and stores the keys on `Subtask.externalKey` (F8). A Jira failure is recorded as a
   * warning and never blocks the pipeline; subtasks that already have a key are skipped, so this is safe to repeat.
   */
  async publishToJira(ticketId: string): Promise<{ created: number; failed: number }> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true, subtasks: { orderBy: { seq: 'asc' } } } });
    const settings = ProjectSettingsSchema.parse(ticket.project.settings);
    if (ticket.source !== 'jira' || !ticket.externalKey || ticket.project.jiraMode !== 'rest' || !settings.jiraWriteBack.createSubtasks) return { created: 0, failed: 0 };

    let created = 0;
    let failed = 0;
    for (const subtask of ticket.subtasks) {
      if (subtask.externalKey) continue;
      try {
        const { key } = await (await this.jira.forRest()).createSubtask(ticket.externalKey, {
          summary: subtask.title,
          description: this.describe(subtask),
          issueTypeName: settings.jiraSubtaskTypeName,
        });
        await this.prisma.subtask.update({ where: { id: subtask.id }, data: { externalKey: key } });
        created++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Creating the Jira sub-task for ${ticket.key} #${subtask.seq} failed: ${message}`);
        await this.prisma.event.create({ data: { ticketId, type: 'jira', message: `Could not create the Jira sub-task for subtask ${subtask.seq} (${subtask.title}): ${message}`.slice(0, 500) } }).catch(() => undefined);
      }
    }
    if (created > 0) await this.prisma.event.create({ data: { ticketId, type: 'jira', message: `Created ${created} Jira sub-task(s)` } });
    return { created, failed };
  }

  private describe(s: { description: string; acceptanceCriteria: unknown }): string {
    const criteria = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.map((c) => `- ${String(c)}`).join('\n') : '';
    return [s.description.trim(), criteria ? `### Acceptance criteria\n${criteria}` : ''].filter(Boolean).join('\n\n');
  }
}
