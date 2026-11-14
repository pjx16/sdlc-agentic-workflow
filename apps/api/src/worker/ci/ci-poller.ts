import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema, loopLimitMessage, type HoldReason } from '@sdlc/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import { PrService } from '../pipeline/pr.service';
import { type Housekeeper } from '../loop/worker-loop';
import { decideCi } from './ci-rules';

/** How often a ticket's checks are looked at (F12). */
export const CI_POLL_MS = 30_000;

/**
 * Housekeeping for tickets in AWAITING_CI (F12): looks at the PR's checks without blocking other work. Passing checks finish the PR and move the
 * ticket on; a failure queues the one CI fix round (picked by `CiFixHandler`) or holds; a timeout holds with the PR left as a draft.
 */
@Injectable()
export class CiPoller implements Housekeeper {
  readonly name = 'ci';
  readonly intervalMs = CI_POLL_MS;
  private readonly logger = new Logger(CiPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
    private readonly pr: PrService,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
    private readonly now: () => number = () => Date.now(),
    private readonly holds?: { onHold(ticketId: string, reason: string, note?: string): Promise<void> },
  ) {}

  async check(): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({ where: { status: 'AWAITING_CI', ciFixPending: false, project: { enabled: true } }, include: { project: true }, orderBy: { createdAt: 'asc' } });
    for (const ticket of tickets) {
      try {
        await this.checkOne(ticket);
      } catch (err) {
        this.logger.error(`CI check for ${ticket.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async checkOne(ticket: Awaited<ReturnType<typeof this.loadOne>>): Promise<void> {
    const settings = ProjectSettingsSchema.parse(ticket.project.settings);
    const started = ticket.ciWaitStartedAt ?? new Date(this.now());
    if (!ticket.ciWaitStartedAt) await this.prisma.ticket.update({ where: { id: ticket.id }, data: { ciWaitStartedAt: started } });

    const number = ticket.prNumber ?? (await this.pr.ensureDraftPr(ticket.id));
    if (!number) return this.holdIt(ticket.id, 'There is no pull request to check (it could not be opened)');

    let checks;
    try {
      checks = await this.github.checks(parseRepo(ticket.project.repoUrl), number);
    } catch (err) {
      // A GitHub hiccup is tried again at the next poll; the timeout still applies.
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: could not read the checks of PR #${number}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
      checks = [{ name: 'unknown', bucket: 'pending' as const }];
    }
    const verdict = decideCi({ checks, waitedMs: this.now() - started.getTime(), timeoutMs: settings.pr.ciTimeoutMin * 60_000 });
    switch (verdict) {
      case 'pending':
        return;
      case 'pass':
        await this.onPass(ticket.id);
        return;
      case 'timeout':
        return this.holdIt(ticket.id, `The checks of PR #${number} did not finish within ${settings.pr.ciTimeoutMin} minutes`);
      case 'fail':
        if (settings.pr.ciFixRound && !ticket.ciFixDone) {
          await this.prisma.ticket.update({ where: { id: ticket.id }, data: { ciFixPending: true } });
          await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Checks of PR #${number} failed; a CI fix round is queued` } });
          return;
        }
        // The CI fix round already ran once: that back-edge is used up (BUILD_PLAN v1 6.8), so the ticket needs a person.
        return ticket.ciFixDone ? this.holdIt(ticket.id, `${loopLimitMessage('ciFix', 1)} The checks of PR #${number} still fail after the CI fix`, 'loop_limit') : this.holdIt(ticket.id, `The checks of PR #${number} failed`);
    }
  }

  protected async onPass(ticketId: string): Promise<void> {
    await this.pr.finalize(ticketId);
    await this.prisma.ticket.update({ where: { id: ticketId }, data: { ciWaitStartedAt: null } });
    await this.states.transition(ticketId, 'IN_HUMAN_REVIEW', 'system', 'Checks passed; the PR is ready for review');
  }

  private async holdIt(ticketId: string, note: string, reason: HoldReason = 'needs_help'): Promise<void> {
    await this.prisma.ticket.update({ where: { id: ticketId }, data: { ciWaitStartedAt: null } });
    await this.states.hold(ticketId, reason, 'system', note);
    await this.holds?.onHold(ticketId, reason, note).catch(() => undefined);
  }

  private loadOne(id: string) {
    return this.prisma.ticket.findUniqueOrThrow({ where: { id }, include: { project: true } });
  }
}
