import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import type { Housekeeper } from '../loop/worker-loop';

/**
 * Every `pollIntervalSec`, looks at the PRs of tickets in IN_HUMAN_REVIEW (F12): merged -> DONE (recording when and how big the PR was), closed without a merge -> hold
 * (`pr_closed`). A GitHub problem is logged and tried again at the next poll.
 */
@Injectable()
export class MergePoller implements Housekeeper {
  readonly name = 'merge';
  readonly intervalMs = (pollIntervalSec: number) => pollIntervalSec;
  private readonly logger = new Logger(MergePoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {}

  async check(): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({ where: { status: 'IN_HUMAN_REVIEW', prNumber: { not: null }, project: { enabled: true } }, include: { project: true }, orderBy: { createdAt: 'asc' } });
    for (const ticket of tickets) {
      try {
        const pr = await this.github.prState(parseRepo(ticket.project.repoUrl), ticket.prNumber as number);
        if (pr.state === 'MERGED') {
          await this.prisma.ticket.update({
            where: { id: ticket.id },
            data: { mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : new Date(), prAdditions: pr.additions ?? null, prDeletions: pr.deletions ?? null, prChangedFiles: pr.changedFiles ?? null },
          });
          await this.states.transition(ticket.id, 'DONE', 'system', `PR #${ticket.prNumber} was merged`);
        }
        else if (pr.state === 'CLOSED') await this.states.hold(ticket.id, 'pr_closed', 'system', `PR #${ticket.prNumber} was closed without being merged`);
      } catch (err) {
        this.logger.warn(`PR state of ${ticket.key} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
