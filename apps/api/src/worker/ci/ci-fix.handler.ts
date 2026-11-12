import { Injectable, Logger } from '@nestjs/common';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CommitGuardError, describeViolations, squashAgentCommits, workspaceViolationsSync } from '../git/commit-guard';
import { PushRejectedError } from '../git/commit';
import { GitRunner } from '../git/git-runner';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import { makeWritableForAgent } from '../git/workspace';
import { WorkspaceService } from '../git/workspace.service';
import { StageLauncher } from '../pipeline/stage-launcher';
import { StageOutcomes } from '../pipeline/stage-outcomes';
import type { StepHandler, StepOutcome } from '../pipeline/step-handler';
import { Inject } from '@nestjs/common';

/**
 * AWAITING_CI with a CI fix pending (F12): one `fix` round with the last 60 lines of the failing log, committed as
 * `fix(<KEY>): resolve CI failure` and pushed. The round is used up whatever happens, then the checks are polled again.
 */
@Injectable()
export class CiFixHandler implements StepHandler {
  readonly status = 'AWAITING_CI' as const;
  private readonly logger = new Logger(CiFixHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitRunner,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    if (!ticket.ciFixPending) return { kind: 'stay' };
    // The single CI fix round is spent from here on, so a failing round cannot loop.
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { ciFixPending: false, ciFixDone: true, ciWaitStartedAt: null } });

    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const ws = this.launcher.workspaceOf(ticket);
    let log = '';
    try {
      if (ticket.branch) log = await this.github.failingLogTail(parseRepo(project.repoUrl), ticket.branch);
    } catch (err) {
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: could not read the failing CI log: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
    }

    await makeWritableForAgent(ws);
    const preHead = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    const result = await this.launcher.launch(
      ticket,
      'fix',
      { failureOutput: log || 'The CI checks failed. No log was available.' },
      { workspacePath: ws, round: 1, reason: 'ci', validate: (e) => (e.status === 'done' && workspaceViolationsSync(ws).length > 0 ? describeViolations(workspaceViolationsSync(ws)) : null) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'fix', result);

    const squashed = await squashAgentCommits(this.git, ws, preHead);
    if (squashed > 0) await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: the agent made ${squashed} commit(s) of its own; they were squashed back` } });
    try {
      await this.workspaces.commit(ticket.id, `fix(${ticket.key}): resolve CI failure`);
      await this.workspaces.push(ticket.id);
    } catch (err) {
      if (err instanceof CommitGuardError || err instanceof PushRejectedError) return { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500), stageRunId: result.stageRunId };
      throw err;
    }
    this.logger.log(`${ticket.key}: CI fix committed`);
    return { kind: 'continue' };
  }
}
