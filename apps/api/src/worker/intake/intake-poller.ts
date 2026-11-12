import { Injectable, Logger } from '@nestjs/common';
import { mapJiraIssueType } from '@sdlc/shared';
import { JiraUnavailableError, type JiraTicket } from '../../jira/jira-client';
import { JiraClients, JiraNotConfiguredError } from '../../jira/jira-clients';
import { Prisma, type Project } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { recordIntake } from '../status/worker-status';

/** When Jira stays unreachable after the client's retries, intake pauses for this long; the pipeline does not pause (BUILD_PLAN 6.3). */
export const INTAKE_BACKOFF_MS = 10 * 60 * 1000;

export interface PollResult {
  /** Why nothing was polled, if so. */
  skipped?: 'intake_paused' | 'backoff';
  projects: number;
  created: number;
  /** Tickets that were already stored. */
  duplicates: number;
  errors: { project: string; message: string }[];
  /** Jira sub-tasks that were left out: they are work items of a ticket, never tickets themselves. */
  subtasksIgnored: number;
}

/** REST-mode intake (F3): runs each project's JQL and stores new tickets as NEW, exactly once per (projectId, externalKey). */
@Injectable()
export class IntakePoller {
  private readonly logger = new Logger(IntakePoller.name);
  private backoffUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: JiraClients,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Milliseconds of intake backoff still to run (0 when polling is allowed). */
  backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - this.now());
  }

  async poll(mode: 'rest' | 'mcp' = 'rest', only?: (project: Project) => boolean): Promise<PollResult> {
    const result: PollResult = { projects: 0, created: 0, duplicates: 0, errors: [], subtasksIgnored: 0 };

    // Pausing intake and pausing the pipeline are separate switches: only the intake switch stops polling.
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (settings?.intakePaused) return this.finish(mode, { ...result, skipped: 'intake_paused' });
    if (this.backoffRemainingMs() > 0) return this.finish(mode, { ...result, skipped: 'backoff' });

    // A project accepts tickets only when its mirror is ready (F2).
    const projects = await this.prisma.project.findMany({ where: { enabled: true, jiraMode: mode, mirrorStatus: 'ok' }, orderBy: { createdAt: 'asc' } });
    for (const project of projects.filter((p) => !only || only(p))) {
      result.projects++;
      try {
        const tickets = await (await this.clients.forMode(mode)).searchTickets(project);
        for (const jt of tickets) {
          if (await this.isSubtask(jt)) {
            result.subtasksIgnored++;
            continue;
          }
          const outcome = await this.store(project, jt);
          if (outcome === 'created') result.created++;
          else if (outcome === 'duplicate') result.duplicates++;
          else result.errors.push({ project: project.name, message: `Jira issue ${jt.key} collides with a pasted ticket key in "${project.name}"` });
        }
      } catch (err) {
        if (err instanceof JiraUnavailableError) {
          this.backoffUntil = this.now() + INTAKE_BACKOFF_MS;
          result.errors.push({ project: project.name, message: err.message });
          this.logger.warn(`${err.message}; intake paused for 10 minutes`);
          await this.prisma.event.create({ data: { type: 'jira', message: 'Jira is unavailable: intake paused for 10 minutes' } }).catch(() => undefined);
          break; // every project talks to the same Jira
        }
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ project: project.name, message });
        if (!(err instanceof JiraNotConfiguredError)) this.logger.warn(`Polling "${project.name}" failed: ${message}`);
      }
    }
    return this.finish(mode, result);
  }

  /** Remembers the outcome of this poll for the dashboard, then returns it. */
  private async finish(mode: 'rest' | 'mcp', result: PollResult): Promise<PollResult> {
    const waiting = await this.prisma.project.count({ where: { enabled: true, jiraMode: mode, mirrorStatus: { not: 'ok' } } }).catch(() => 0);
    await recordIntake(this.prisma, {
      mode,
      projects: result.projects,
      waiting,
      created: result.created,
      seen: result.created + result.duplicates,
      error: result.errors[0]?.message,
      skipped: result.skipped,
    });
    return result;
  }

  /**
   * Sub-tasks are never tickets. The pipeline breaks a ticket into subtasks and publishes them to Jira as sub-tasks for visibility; the
   * implement stage works through them one by one, so intake must not take them back as new tickets. A Jira issue is a sub-task when
   * its type says so, when it has a parent, or when it is one the pipeline created itself.
   */
  private async isSubtask(jt: JiraTicket): Promise<boolean> {
    if (jt.isSubtask || /^sub[-\s]?tasks?$/i.test(jt.issuetype.trim())) return true;
    return (await this.prisma.subtask.count({ where: { externalKey: jt.key } })) > 0;
  }

  private async store(project: Project, jt: JiraTicket): Promise<'created' | 'duplicate' | 'collision'> {
    try {
      const ticket = await this.prisma.ticket.create({
        data: {
          projectId: project.id,
          key: jt.key,
          externalKey: jt.key,
          source: 'jira',
          type: mapJiraIssueType(jt.issuetype),
          title: jt.summary,
          body: jt.description,
          labels: jt.labels,
          status: 'NEW',
        },
      });
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'intake', message: `${jt.key} picked up from Jira` } });
      return 'created';
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      // Either this Jira issue is already stored (the normal case for every poll after the first)...
      if (await this.prisma.ticket.findFirst({ where: { projectId: project.id, externalKey: jt.key }, select: { id: true } })) return 'duplicate';
      // ...or a pasted ticket already uses this key (a local prefix equal to the Jira project key). Do not lose it silently.
      await this.prisma.event.create({ data: { type: 'error', message: `Jira issue ${jt.key} was skipped: a pasted ticket in "${project.name}" already uses that key` } }).catch(() => undefined);
      return 'collision';
    }
  }
}
