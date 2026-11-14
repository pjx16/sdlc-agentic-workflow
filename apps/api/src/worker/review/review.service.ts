import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ProjectSettingsSchema, securityTriggered, type StageEnvelope, type StageName } from '@sdlc/shared';
import type { ReviewFinding, Ticket } from '../../generated/prisma/client';
import { writeArtifact } from '../../common/artifacts';
import { PrismaService } from '../../prisma/prisma.service';
import type { FindingInfo } from '../agent-runner/context-builder';
import { GitRunner } from '../git/git-runner';
import { StageLauncher } from '../pipeline/stage-launcher';
import { StageOutcomes } from '../pipeline/stage-outcomes';
import type { StepOutcome } from '../pipeline/step-handler';
import { WorkerConfig } from '../worker-config';
import { computeChangedPaths, computeDiff } from './diff';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { MAX_FINDINGS_PER_ROUND } from './review-findings';

interface ReviewData {
  findings: { severity: string; file: string; line: number | null; issue: string; rule: string; fix: string }[];
  previousFindings: { id: string; status: 'fixed' | 'still_open' }[];
}

export type ReviewRoundResult =
  | { kind: 'reviewed'; round: number; summary: string; findings: ReviewFinding[]; fixed: number; stillOpen: number; stageRunId: string }
  | { kind: 'outcome'; outcome: StepOutcome };

const toInfo = (f: ReviewFinding): FindingInfo => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, issue: f.issue, rule: f.rule, fix: f.fix });

/** The `review` stage (F10): one round per call, with its findings stored per round. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly git: GitRunner,
    private readonly config: WorkerConfig,
    @Optional() @Inject(OrchestratorService) private readonly orchestrator?: OrchestratorService,
  ) {}

  /** The text of the review checklist from the guidelines directory ('' if the file is missing). */
  private async checklist(): Promise<string> {
    return readFile(path.join(this.config.guidelinesDir, 'review-checklist.md'), 'utf8').catch(() => '');
  }

  /**
   * Runs review round `ticket.reviewRound + 1`. Round 1 sees the diff from the base branch to HEAD; later rounds see the previous
   * findings and only the diff since the last reviewed commit. Above `reviewMaxDiffLines` the stage gets the diff stat and reads the
   * diff file by file. Findings are stored per round; the reviewed commit is recorded.
   */
  async runRound(ticket: Ticket): Promise<ReviewRoundResult> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const ws = this.launcher.workspaceOf(ticket);
    const round = ticket.reviewRound + 1;

    const range = round === 1 || !ticket.lastReviewedSha ? { from: `origin/${project.baseBranch}`, mergeBase: true } : { from: ticket.lastReviewedSha, mergeBase: false };
    const diff = await computeDiff(this.git, ws, range);
    const diffRange = `${range.from}${range.mergeBase ? '...' : '..'}HEAD`;
    const tooLarge = diff.lines > settings.limits.reviewMaxDiffLines;

    const subtasks = await this.prisma.subtask.findMany({ where: { ticketId: ticket.id }, orderBy: { seq: 'asc' } });
    const acceptanceCriteria = subtasks.flatMap((s) => (Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.map((c) => `${s.title}: ${String(c)}`) : []));
    const allPrevious = round === 1 ? [] : await this.prisma.reviewFinding.findMany({ where: { ticketId: ticket.id, round: { lt: round }, status: 'open' }, orderBy: { id: 'asc' } });
    const changed = await computeChangedPaths(this.git, ws, range);
    const security = securityTriggered(changed, diff.patch, settings.securityRiskPatterns);
    const reviewers: StageName[] = ['prReview'];
    if (settings.stages.qualityReview.enabled) reviewers.push('qualityReview');
    if (settings.stages.securityReview.enabled && security.triggered) reviewers.push('securityReview');
    else if (settings.stages.securityReview.enabled && round === 1 && this.orchestrator) {
      // The code rules did not call the security reviewer; the orchestrator may add it (BUILD_PLAN v1 6.11), once, on the first round.
      const pick = await this.orchestrator.choose(
        ticket,
        'security_add',
        [{ kind: 'skip', to: 'skip', label: 'Do not run the security review' }, { kind: 'add', to: 'add', label: 'Run the security review as well' }],
        'skip',
        `${changed.length} file(s) changed: ${changed.slice(0, 12).join(', ')}`,
      );
      if (pick.option.kind === 'add') {
        reviewers.push('securityReview');
        security.reasons.push(`the orchestrator asked for it: ${pick.reason || 'no reason given'}`);
      }
    }
    // A reviewer that ran before keeps its own open findings in sight; one that did not run this round leaves them open.

    const seen = new Set<string>();
    const merged: { reviewer: StageName; f: ReviewData['findings'][number] }[] = [];
    const fixedIds: string[] = [];
    const considered = new Set<string>();
    let summary = '';
    let firstRunId = '';
    let criteria: unknown = undefined;
    const failedReviewers: StageName[] = [];
    for (const reviewer of reviewers) {
      const mine = allPrevious.filter((p) => p.reviewer === reviewer);
      const result = await this.launcher.launch(
        ticket,
        reviewer,
        {
          ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
          acceptanceCriteria,
          reviewChecklist: await this.checklist(),
          previousFindings: mine.map(toInfo),
          ...(reviewer === 'securityReview' ? { securityReasons: security.reasons } : {}),
          ...(tooLarge ? { diffStat: diff.stat, diffRange, diffLines: diff.lines } : { diff: diff.patch }),
        },
        { workspacePath: ws, round, validate: (envelope) => this.validate(envelope) },
      );
      if (result.kind !== 'done') {
        // The PR reviewer is the review: without it the round cannot finish. An extra reviewer that fails is recorded and skipped, so one
        // flaky optional agent never holds the ticket.
        if (reviewer === 'prReview') return { kind: 'outcome', outcome: await this.outcomes.forResult(ticket.id, reviewer, result) };
        failedReviewers.push(reviewer);
        await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'review', level: 'warn', source: 'review', message: `The ${reviewer === 'securityReview' ? 'security' : 'quality'} reviewer did not finish (${result.kind}); the round went on without it${reviewer === 'securityReview' ? ', so the security check did NOT run' : ''}` } });
        continue;
      }
      const data = (result.envelope as StageEnvelope).data as ReviewData & { criteria?: unknown };
      if (!firstRunId) {
        firstRunId = result.stageRunId;
        summary = result.envelope.summary;
        criteria = data.criteria;
      }
      const mineIds = new Set(mine.map((p) => p.id));
      for (const p of mine) considered.add(p.id);
      for (const p of data.previousFindings) if (p.status === 'fixed' && mineIds.has(p.id)) fixedIds.push(p.id);
      for (const f0 of data.findings) {
        // The quality reviewer never blocks a merge: its findings stay at medium or below.
        const f = reviewer === 'qualityReview' && (f0.severity === 'critical' || f0.severity === 'high') ? { ...f0, severity: 'medium' } : f0;
        const key = `${f.file}|${f.line ?? ''}|${f.issue.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ reviewer, f });
      }
    }
    const head = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    if (fixedIds.length > 0) await this.prisma.reviewFinding.updateMany({ where: { id: { in: fixedIds } }, data: { status: 'fixed' } });

    const stored: ReviewFinding[] = [];
    for (const { reviewer, f } of merged) {
      stored.push(await this.prisma.reviewFinding.create({ data: { ticketId: ticket.id, round, reviewer, severity: f.severity, file: f.file, line: f.line, issue: f.issue, rule: f.rule, fix: f.fix, status: 'open' } }));
    }
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { reviewRound: round, lastReviewedSha: head } });
    await writeArtifact(this.prisma, ticket.id, 'review', { round, summary, reviewers, failedReviewers, criteria, findings: merged.map((m) => ({ ...m.f, reviewer: m.reviewer })) }, firstRunId).catch(() => undefined);
    const stillOpen = considered.size - fixedIds.length;
    return { kind: 'reviewed', round, summary, findings: stored, fixed: fixedIds.length, stillOpen, stageRunId: firstRunId };
  }

  /** At most 10 findings per round, each with a file (F10). A violation fails the attempt (BUILD_PLAN 6.8). */
  private validate(envelope: StageEnvelope): string | null {
    if (envelope.status !== 'done') return null;
    const findings = (envelope.data as ReviewData | undefined)?.findings ?? [];
    if (findings.length > MAX_FINDINGS_PER_ROUND) return `${findings.length} findings is more than the limit of ${MAX_FINDINGS_PER_ROUND} per round`;
    return null;
  }

  /** Every finding still open, from any round: a finding stays open until a later round reports it fixed. */
  openFindings(ticketId: string): Promise<ReviewFinding[]> {
    return this.prisma.reviewFinding.findMany({ where: { ticketId, status: 'open' }, orderBy: [{ round: 'asc' }, { id: 'asc' }] });
  }
}
