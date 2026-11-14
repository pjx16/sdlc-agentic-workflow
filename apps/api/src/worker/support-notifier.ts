import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { ProjectSettingsSchema, events } from '@sdlc/shared';
import { logEvent } from '../common/event-log';
import type { SupportTicket } from '../generated/prisma/client';
import { jiraMarker } from '../jira/jira-client';
import { JiraClients } from '../jira/jira-clients';
import { PrismaService } from '../prisma/prisma.service';
import { SupportRaiser, type SupportNotifierPort } from '../support/support-raiser';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from './github/github-client';

/**
 * A blocking support ticket also reaches the places people look (BUILD_PLAN v1 D8): a comment on the Jira issue and, when
 * there is a PR, a comment on the PR. Best effort: a Jira or GitHub problem is a recorded warning, never a block.
 * The PR comment for a `needs_help` hold is already written by the HoldNotifier, so it is not written twice.
 */
import { FormatLoader } from './format-loader';
@Injectable()
export class SupportNotifier implements SupportNotifierPort, OnModuleInit {
  private readonly logger = new Logger(SupportNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraClients,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
    private readonly raiser: SupportRaiser,
    @Optional() formats?: FormatLoader,
  ) {
    this.formats = formats ?? new FormatLoader();
  }

  private readonly formats: FormatLoader;

  /** The worker registers itself: the raiser is shared with the state machine, which has no GitHub client. */
  onModuleInit(): void {
    this.raiser.notifier = this;
  }

  async onRaised(ticket: SupportTicket): Promise<void> {
    if (ticket.priority !== 'blocking' || !ticket.ticketId) return;
    const t = await this.prisma.ticket.findUnique({ where: { id: ticket.ticketId }, include: { project: true } });
    if (!t) return;
    const text = `**Needs you:** ${ticket.title}\n\n${ticket.body}`.slice(0, 4000);

    const settings = ProjectSettingsSchema.parse(t.project.settings);
    if (t.source === 'jira' && t.externalKey && t.project.jiraMode === 'rest' && settings.jiraWriteBack.comments) {
      try {
        await (await this.jira.forRest()).comment(t.externalKey, await this.formats.fill('jira-needs-you', { title: ticket.title, body: ticket.body.slice(0, 3800) }), jiraMarker(t.key, `support-${ticket.id}`, ticket.id));
      } catch (err) {
        await this.warn(t.id, 'JIRA_ERROR', 'jira', `Could not tell Jira about "${ticket.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const coveredByHoldNotifier = ticket.kind === 'hold' && t.holdReason === 'needs_help';
    if (t.prNumber && !coveredByHoldNotifier) {
      try {
        await this.github.comment(parseRepo(t.project.repoUrl), t.prNumber, `## Needs a person\n\n${text}\n`);
      } catch (err) {
        await this.warn(t.id, 'GITHUB_ERROR', 'github', `Could not comment on PR #${t.prNumber} about "${ticket.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async warn(ticketId: string, code: 'JIRA_ERROR' | 'GITHUB_ERROR', source: 'jira' | 'github', message: string): Promise<void> {
    this.logger.warn(message);
    await logEvent(this.prisma, { ...events.note({ source, type: source === 'jira' ? 'jira' : 'git', level: 'warn', message: message.slice(0, 500) }), errorCode: code }, { ticketId });
  }
}
