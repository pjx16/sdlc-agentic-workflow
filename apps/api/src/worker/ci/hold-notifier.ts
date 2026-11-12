import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';

/**
 * When a ticket goes on hold for `needs_help` and has an open PR, the PR (still a draft) gets a comment saying why (3.7), so the
 * people looking at the PR are not left guessing. Best effort: a GitHub problem is a recorded warning.
 */
@Injectable()
export class HoldNotifier {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {}

  async onHold(ticketId: string, reason: string, note?: string): Promise<void> {
    if (reason !== 'needs_help') return;
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: { project: true } });
    if (!ticket?.prNumber) return;
    const body = `## Paused: needs help\n\n${(note ?? 'The pipeline stopped on this ticket and needs a developer to look at it.').trim()}\n\nThis PR stays a draft. The ticket continues after a developer chooses Retry or Resume in the dashboard.\n`;
    try {
      await this.github.comment(parseRepo(ticket.project.repoUrl), ticket.prNumber, body);
    } catch (err) {
      await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Warning: could not comment on PR #${ticket.prNumber} about the hold: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
    }
  }
}
