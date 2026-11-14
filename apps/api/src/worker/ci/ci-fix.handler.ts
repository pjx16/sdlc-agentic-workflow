import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import { SupportRaiser } from '../../support/support-raiser';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CommitGuardError, describeViolations, squashAgentCommits, workspaceViolationsSync } from '../git/commit-guard';
import { PushRejectedError } from '../git/commit';
import { PolicyError } from '../common/retry-policy';
import { GitRunner } from '../git/git-runner';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import { makeWritableForAgent } from '../git/workspace';
import { WorkspaceService } from '../git/workspace.service';
import { StageLauncher } from '../pipeline/stage-launcher';
import { StageOutcomes } from '../pipeline/stage-outcomes';
import type { StepHandler, StepOutcome } from '../pipeline/step-handler';
import { Inject } from '@nestjs/common';
import { OrchestratorService } from '../orchestrator/orchestrator.service';

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
    @Optional() raiser?: SupportRaiser,
    @Optional() @Inject(OrchestratorService) private readonly orchestrator?: OrchestratorService,
  ) {
    this.raiser = raiser ?? new SupportRaiser(prisma);
  }

  private readonly raiser: SupportRaiser;

  async run(ticket: Ticket): Promise<StepOutcome> {
    if (!ticket.ciFixPending) return { kind: 'stay' };
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const ws = this.launcher.workspaceOf(ticket);
    let log = '';
    try {
      if (ticket.branch) log = await this.github.failingLogTail(parseRepo(project.repoUrl), ticket.branch);
    } catch (err) {
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: could not read the failing CI log: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
    }

    if (settings.stages.ciTriage.enabled) {
      const triage = await this.triage(ticket, ws, log);
      if (triage) return triage;
    }
    // The single CI fix round is spent from here on, so a failing round cannot loop.
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { ciFixPending: false, ciFixDone: true, ciWaitStartedAt: null } });

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
      if (err instanceof CommitGuardError || err instanceof PushRejectedError || err instanceof PolicyError) return { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500), stageRunId: result.stageRunId };
      throw err;
    }
    this.logger.log(`${ticket.key}: CI fix committed`);
    return { kind: 'continue' };
  }

  /**
   * The CI triager says what kind of failure this is (BUILD_PLAN v1 4.1). `code` goes on to the fixer (returns null). `flaky` runs the
   * checks again once; a second flaky, or `infra`, becomes a CI problem for a person.
   */
  private async triage(ticket: Ticket, ws: string, log: string): Promise<StepOutcome | null> {
    const result = await this.launcher.launch(ticket, 'ciTriage', { ci: { check: 'CI', logTail: log || 'No log was available.', reruns: ticket.ciRerunDone ? 1 : 0 } }, { workspacePath: ws });
    if (result.kind !== 'done') {
      // A triager that fails must not stop the pipeline: treat the failure as a code failure and go on to the fixer.
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'error', level: 'warn', message: 'The CI triager did not answer; the failure is treated as a code failure'.slice(0, 500) } }).catch(() => undefined);
      return null;
    }
    const data = result.envelope.data as { kind: 'code' | 'flaky' | 'infra'; summary: string };
    await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `CI failure triaged as ${data.kind}: ${data.summary}`.slice(0, 500) } });
    if (data.kind === 'code') return null;
    // A second flaky failure in a row: the orchestrator may allow one more run of the checks (BUILD_PLAN v1 6.11); the default is a support ticket.
    let again = false;
    if (data.kind === 'flaky' && ticket.ciRerunDone && ticket.branch && this.orchestrator && (await this.prisma.orchestratorDecision.count({ where: { ticketId: ticket.id, point: 'ci_flaky' } })) === 0) {
      const pick = await this.orchestrator.choose(ticket, 'ci_flaky', [{ kind: 'support', to: 'support', label: 'Raise a support ticket' }, { kind: 'rerun', to: 'rerun', label: 'Run the checks once more' }], 'support', `Triage summary: ${data.summary}`);
      again = pick.option.kind === 'rerun';
    }
    if (data.kind === 'flaky' && (!ticket.ciRerunDone || again) && ticket.branch) {
      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
      try {
        await this.github.rerunFailed(parseRepo(project.repoUrl), ticket.branch);
        await this.prisma.ticket.update({ where: { id: ticket.id }, data: { ciFixPending: false, ciRerunDone: true, ciWaitStartedAt: null } });
        return { kind: 'stay' };
      } catch (err) {
        await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: could not run the checks again: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
      }
    }
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { ciFixPending: false, ciWaitStartedAt: null } });
    await this.raiser.raise({ kind: 'ci_infra', ticketId: ticket.id, projectId: ticket.projectId, stage: 'ciTriage', stageRunId: result.stageRunId, dedupeKey: `ci_infra:${ticket.id}`, title: `CI problem on ${ticket.key}`, body: `${data.kind === 'flaky' ? 'A test failed again after the checks were run once more.' : 'The failure looks like a problem with the CI infrastructure, not with the code.'}\n\n${data.summary}` });
    return { kind: 'hold', reason: 'needs_help', note: data.summary.slice(0, 500), stageRunId: result.stageRunId };
  }
}
