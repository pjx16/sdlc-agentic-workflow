import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import { buildPrDescription } from '../github/pr-description';
import { WorkerConfig } from '../worker-config';

/** Opens (once) and describes the ticket's draft pull request (F9). */
@Injectable()
export class PrService {
  private readonly logger = new Logger(PrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {}

  /** The description, assembled from what is on record right now. */
  async describe(ticketId: string): Promise<string> {
    const t = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true, subtasks: { orderBy: { seq: 'asc' } } } });
    return buildPrDescription({
      ticket: { key: t.key, title: t.title, body: t.body, externalKey: t.externalKey },
      jiraBaseUrl: this.config.jiraBaseUrl || undefined,
      testCommand: t.project.testCmdTemplate,
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
}
