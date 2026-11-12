import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import { buildPrDescription } from '../github/pr-description';
import { renderReviewSummary } from '../review/review-comment';
import { WorkerConfig } from '../worker-config';

/** Opens (once) and describes the ticket's draft pull request (F9). */
@Injectable()
export class PrService {
  private readonly logger = new Logger(PrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    private readonly creds: CredentialsService,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {}

  /** The description, assembled from what is on record right now. */
  async describe(ticketId: string): Promise<string> {
    const t = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true, subtasks: { orderBy: { seq: 'asc' } } } });
    return buildPrDescription({
      ticket: { key: t.key, title: t.title, body: t.body, externalKey: t.externalKey },
      jiraBaseUrl: (await this.creds.resolve()).jira_base_url || undefined,
      testCommand: t.project.testCmdTemplate,
      remainingFindings: await this.remainingFindings(ticketId, t.reviewRound),
      subtasks: t.subtasks.map((s) => ({ seq: s.seq, title: s.title, featCommit: s.featCommit, acceptanceCriteria: Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.map(String) : [] })),
    });
  }

  /**
   * Opens the draft PR against the base branch if there is none yet, storing `prNumber` and `prUrl`. Idempotent. A GitHub problem is a
   * recorded warning, not a failure: it is tried again at the next opportunity. Returns the PR number, or null if there is none.
   */
  async ensureDraftPr(ticketId: string): Promise<number | null> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true } });
    if (ticket.prNumber) return ticket.prNumber;
    if (!ticket.branch) return null;
    try {
      const repo = parseRepo(ticket.project.repoUrl);
      const opened = await this.github.openDraftPr({ repo, base: ticket.project.baseBranch, head: ticket.branch, title: `${ticket.key}: ${ticket.title}`, body: await this.describe(ticketId) });
      await this.prisma.ticket.update({ where: { id: ticketId }, data: { prNumber: opened.number, prUrl: opened.url } });
      await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Opened draft PR #${opened.number}: ${opened.url}` } });
      return opened.number;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Opening the draft PR for ${ticket.key} failed: ${message}`);
      await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Warning: could not open the draft PR: ${message}`.slice(0, 500) } });
      return null;
    }
  }

  /** Whether the draft PR should be opened now: after the first subtask with `pr.earlyDraft`, otherwise after the last one. */
  static shouldOpenEarly(settingsJson: unknown): boolean {
    return ProjectSettingsSchema.parse(settingsJson).pr.earlyDraft;
  }

  /**
   * Posts a comment on the ticket's PR (opening the draft first if there is none yet). A GitHub problem is a recorded warning and
   * never blocks the pipeline. Returns whether the comment was posted.
   */
  async postComment(ticketId: string, body: string): Promise<boolean> {
    const number = await this.ensureDraftPr(ticketId);
    if (!number) return false;
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true } });
    try {
      await this.github.comment(parseRepo(ticket.project.repoUrl), number, body);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Warning: could not post the comment on PR #${number}: ${message}`.slice(0, 500) } });
      return false;
    }
  }

  /** Open medium and low findings of the last review round, for the "Review notes" section. */
  private async remainingFindings(ticketId: string, round: number): Promise<{ medium: number; low: number }> {
    if (round === 0) return { medium: 0, low: 0 };
    const rows = await this.prisma.reviewFinding.groupBy({ by: ['severity'], where: { ticketId, status: 'open' }, _count: true });
    const n = (sev: string) => rows.find((r) => r.severity === sev)?._count ?? 0;
    return { medium: n('medium'), low: n('low') };
  }

  /**
   * Passing checks (F12): marks the PR ready, rewrites its description, and posts the review summary. Each GitHub call is separate, so a problem
   * with one is a recorded warning and the others still happen; the ticket moves on either way. Returns the warnings.
   */
  async finalize(ticketId: string): Promise<string[]> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true } });
    const number = ticket.prNumber;
    if (!number) return ['there is no pull request to mark ready'];
    const repo = parseRepo(ticket.project.repoUrl);
    const warnings: string[] = [];
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await attempt('mark ready', () => this.github.markReady(repo, number));
    await attempt('rewrite the description', async () => this.github.editBody(repo, number, await this.describe(ticketId)));
    const open = await this.prisma.reviewFinding.groupBy({ by: ['severity'], where: { ticketId, status: 'open' }, _count: true });
    const fixed = await this.prisma.reviewFinding.count({ where: { ticketId, status: 'fixed' } });
    const count = (sev: string) => open.find((r) => r.severity === sev)?._count ?? 0;
    const summary = renderReviewSummary({ rounds: ticket.reviewRound, fixed, open: { critical: count('critical'), high: count('high'), medium: count('medium'), low: count('low') } });
    await attempt('post the summary', () => this.github.comment(repo, number, summary));
    for (const w of warnings) await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Warning: could not ${w}`.slice(0, 500) } });
    return warnings;
  }
}
