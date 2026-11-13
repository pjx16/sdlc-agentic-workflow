import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, type StageEnvelope } from '@sdlc/shared';
import type { ReviewFinding, Ticket } from '../../generated/prisma/client';
import { writeArtifact } from '../../common/artifacts';
import { PrismaService } from '../../prisma/prisma.service';
import type { FindingInfo } from '../agent-runner/context-builder';
import { GitRunner } from '../git/git-runner';
import { StageLauncher } from '../pipeline/stage-launcher';
import { StageOutcomes } from '../pipeline/stage-outcomes';
import type { StepOutcome } from '../pipeline/step-handler';
import { WorkerConfig } from '../worker-config';
import { computeDiff } from './diff';
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
    const previous = round === 1 ? [] : await this.prisma.reviewFinding.findMany({ where: { ticketId: ticket.id, round: { lt: round }, status: 'open' }, orderBy: { id: 'asc' } });

    const result = await this.launcher.launch(
      ticket,
      'review',
      {
        ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
        acceptanceCriteria,
        reviewChecklist: await this.checklist(),
        previousFindings: previous.map(toInfo),
        ...(tooLarge ? { diffStat: diff.stat, diffRange, diffLines: diff.lines } : { diff: diff.patch }),
      },
      {
        workspacePath: ws,
        round,
        validate: (envelope) => this.validate(envelope),
      },
    );
    if (result.kind !== 'done') return { kind: 'outcome', outcome: await this.outcomes.forResult(ticket.id, 'review', result) };

    const data = (result.envelope as StageEnvelope).data as ReviewData;
    const head = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });

    // Previous findings: the stage says which are fixed; anything it does not mention stays open.
    const previousIds = new Set(previous.map((p) => p.id));
    const fixedIds = data.previousFindings.filter((p) => p.status === 'fixed' && previousIds.has(p.id)).map((p) => p.id);
    if (fixedIds.length > 0) await this.prisma.reviewFinding.updateMany({ where: { id: { in: fixedIds } }, data: { status: 'fixed' } });

    const stored: ReviewFinding[] = [];
    for (const f of data.findings) {
      stored.push(await this.prisma.reviewFinding.create({ data: { ticketId: ticket.id, round, severity: f.severity, file: f.file, line: f.line, issue: f.issue, rule: f.rule, fix: f.fix, status: 'open' } }));
    }
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { reviewRound: round, lastReviewedSha: head } });
    await writeArtifact(this.prisma, ticket.id, 'review', { round, summary: result.envelope.summary, findings: data.findings }, result.stageRunId).catch(() => undefined);
    return { kind: 'reviewed', round, summary: result.envelope.summary, findings: stored, fixed: fixedIds.length, stillOpen: previous.length - fixedIds.length, stageRunId: result.stageRunId };
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
