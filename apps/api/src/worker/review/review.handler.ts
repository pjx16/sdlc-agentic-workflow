import { Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CommitGuardError, describeViolations, squashAgentCommits, workspaceViolationsSync } from '../git/commit-guard';
import { PushRejectedError } from '../git/commit';
import { PolicyError } from '../common/retry-policy';
import { GitRunner } from '../git/git-runner';
import { makeWritableForAgent } from '../git/workspace';
import { WorkspaceService } from '../git/workspace.service';
import { PrService } from '../pipeline/pr.service';
import { StageLauncher } from '../pipeline/stage-launcher';
import { StageOutcomes } from '../pipeline/stage-outcomes';
import type { StepHandler, StepOutcome } from '../pipeline/step-handler';
import { renderFindingsForFix, renderReviewComment } from './review-comment';
import { blocksReview } from './review-findings';
import { nextAfterReview } from './review-rules';
import { ReviewService } from './review.service';

/**
 * REVIEW (row 11/12): review rounds and fix rounds, one step per loop iteration (F10). A round reviews the current HEAD and posts its
 * findings as a PR comment. With open critical or high findings and rounds left, `fix` runs on those findings only and is committed as
 * `fix(<KEY>): address review round <n>`; then the next round starts. Otherwise the loop ends and the ticket moves on.
 */
@Injectable()
export class ReviewHandler implements StepHandler {
  readonly status = 'REVIEW' as const;
  private readonly logger = new Logger(ReviewHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviews: ReviewService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitRunner,
    private readonly pr: PrService,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const ws = this.launcher.workspaceOf(ticket);
    const head = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });

    // HEAD has not been reviewed yet (the first round, or commits since the last one): review it.
    if (ticket.reviewRound === 0 || ticket.lastReviewedSha !== head) return this.reviewRound(ticket);

    const open = await this.reviews.openFindings(ticket.id);
    const blocking = open.filter((f) => blocksReview(f.severity));
    const next = nextAfterReview({ roundsRun: ticket.reviewRound, maxReviewRounds: settings.limits.maxReviewRounds, openBlocking: blocking.length });
    if (next === 'fix' && !(await this.fixAlreadyRan(ticket))) return this.fixRound(ticket, ws, blocking);

    // The loop ends: with findings left that is not a failure; they stay listed (F10, 3.7).
    await this.pr.ensureDraftPr(ticket.id);
    return settings.stages.kbUpdate.enabled
      ? { kind: 'transition', to: 'KB_UPDATE', reason: `Review finished after ${ticket.reviewRound} round(s)` }
      : { kind: 'transition', to: 'AWAITING_CI', reason: `Review finished after ${ticket.reviewRound} round(s); the KB update is off` };
  }

  private async fixAlreadyRan(ticket: Ticket): Promise<boolean> {
    return (await this.prisma.stageRun.count({ where: { ticketId: ticket.id, stage: 'fix', reason: 'review', round: ticket.reviewRound, status: 'succeeded' } })) > 0;
  }

  private async reviewRound(ticket: Ticket): Promise<StepOutcome> {
    const result = await this.reviews.runRound(ticket);
    if (result.kind === 'outcome') return result.outcome;
    const body = renderReviewComment({ round: result.round, summary: result.summary, findings: result.findings, previous: { fixed: result.fixed, stillOpen: result.stillOpen } });
    await this.pr.postComment(ticket.id, body);
    return { kind: 'continue' };
  }

  private async fixRound(ticket: Ticket, ws: string, blocking: Parameters<typeof renderFindingsForFix>[0]): Promise<StepOutcome> {
    await makeWritableForAgent(ws);
    const preHead = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    const result = await this.launcher.launch(
      ticket,
      'fix',
      { failureOutput: renderFindingsForFix(blocking) },
      { workspacePath: ws, round: ticket.reviewRound, reason: 'review', validate: (e) => (e.status === 'done' && workspaceViolationsSync(ws).length > 0 ? describeViolations(workspaceViolationsSync(ws)) : null) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'fix', result);

    const squashed = await squashAgentCommits(this.git, ws, preHead);
    if (squashed > 0) await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: the agent made ${squashed} commit(s) of its own; they were squashed back` } });
    try {
      await this.workspaces.commit(ticket.id, `fix(${ticket.key}): address review round ${ticket.reviewRound}`);
      await this.workspaces.push(ticket.id);
    } catch (err) {
      if (err instanceof CommitGuardError || err instanceof PushRejectedError || err instanceof PolicyError) return { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500), stageRunId: result.stageRunId };
      throw err;
    }
    this.logger.log(`${ticket.key}: fix for review round ${ticket.reviewRound} committed`);
    return { kind: 'continue' };
  }
}
