import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { ReviewService } from './review.service';

const finding = (over: Record<string, unknown> = {}) => ({ severity: 'high', file: 'src/f1.ts', line: 3, issue: 'Unvalidated input', rule: 'Security: input validation', fix: 'Validate it', ...over });
const review = (findings: unknown[], previousFindings: unknown[] = [], summary = 'Reviewed'): StageEnvelope => ({ status: 'done', summary, data: { findings, previousFindings } as never });

describe('review stage and findings storage (F10)', () => {
  let h: StepsHarness;
  let service: ReviewService;

  /** A ticket with two finished subtasks and a commit on its branch. */
  const withWork = async () => {
    const t = await h.ticket({ status: 'REVIEW' });
    await h.subtask(t.id, 1, { status: 'DONE', acceptanceCriteria: ['Exports all bookings', 'Handles empty data'] });
    await h.subtask(t.id, 2, { status: 'DONE', acceptanceCriteria: ['Has an endpoint'] });
    h.write(h.ws(t), 'src/f1.ts', 'export const f1 = (x: string) => x;\n');
    await h.workspaces.commit(t.id, `feat(${t.key}): one`);
    return t;
  };
  const rows = (ticketId: string, round?: number) => h.prisma.reviewFinding.findMany({ where: { ticketId, ...(round ? { round } : {}) }, orderBy: [{ round: 'asc' }, { id: 'asc' }] });

  beforeAll(async () => {
    h = await StepsHarness.create();
    mkdirSync(path.join(h.tmp, 'guidelines'), { recursive: true });
    writeFileSync(path.join(h.tmp, 'guidelines', 'review-checklist.md'), '# Checklist\n- be correct\n');
    service = new ReviewService(h.prisma, h.launcher, h.outcomes, h.git, h.config);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.agent.requests = [];
    h.agent.override = null;
    await h.setProject({ settings: {} });
  });

  describe('round 1', () => {
    it('reviews the diff from the base branch to HEAD with the acceptance criteria and checklist, and stores the findings for round 1', async () => {
      const t = await withWork();
      h.agent.scripts.review = () => review([finding(), finding({ severity: 'low', file: 'src/f1.ts', line: null, issue: 'Name', rule: 'Practices: naming' })], [], 'Two issues');
      const res = await service.runRound(t);
      expect(res).toMatchObject({ kind: 'reviewed', round: 1, summary: 'Two issues', fixed: 0, stillOpen: 0 });

      const req = h.agent.requests[0];
      expect(req).toMatchObject({ stage: 'review', round: 1, modelAlias: 'sonnet', maxTurns: 10 });
      expect(req?.inputs.diff).toContain('src/f1.ts');
      expect(req?.inputs.diff).toContain('export const f1 = (x: string) => x;');
      expect(req?.inputs.acceptanceCriteria).toEqual(['Subtask 1: Exports all bookings', 'Subtask 1: Handles empty data', 'Subtask 2: Has an endpoint']);
      expect(req?.inputs.reviewChecklist).toContain('be correct');
      expect(req?.inputs.previousFindings).toEqual([]);

      const stored = await rows(t.id);
      expect(stored.map((f) => [f.round, f.severity, f.file, f.line, f.status])).toEqual([[1, 'high', 'src/f1.ts', 3, 'open'], [1, 'low', 'src/f1.ts', null, 'open']]);
      expect(stored[0]).toMatchObject({ issue: 'Unvalidated input', rule: 'Security: input validation', fix: 'Validate it' });
      const after = await h.reloadTicket(t.id);
      expect(after.reviewRound).toBe(1);
      expect(after.lastReviewedSha).toBe(sh(h.ws(t), 'rev-parse', 'HEAD'));
    });

    it('with no findings, stores none and still records the round', async () => {
      const t = await withWork();
      h.agent.scripts.review = () => review([]);
      expect(await service.runRound(t)).toMatchObject({ kind: 'reviewed', round: 1, findings: [] });
      expect(await rows(t.id)).toEqual([]);
      expect((await h.reloadTicket(t.id)).reviewRound).toBe(1);
    });
  });

  describe('round 2 sees only what is new', () => {
    it('gets the previous open findings and only the diff since the last reviewed commit', async () => {
      const t = await withWork();
      h.agent.scripts.review = () => review([finding(), finding({ severity: 'medium', issue: 'Magic number' })]);
      await service.runRound(t);
      const round1 = await rows(t.id, 1);

      // The fix after review 1.
      h.write(h.ws(t), 'src/fixed.ts', 'export const fixed = true;\n');
      await h.workspaces.commit(t.id, `fix(${t.key}): address review round 1`);

      h.agent.scripts.review = () => review([finding({ severity: 'low', file: 'src/fixed.ts', issue: 'Nit', rule: 'Practices' })], [{ id: round1[0]?.id, status: 'fixed' }, { id: round1[1]?.id, status: 'still_open' }]);
      const res = await service.runRound(await h.reloadTicket(t.id));
      expect(res).toMatchObject({ kind: 'reviewed', round: 2, fixed: 1, stillOpen: 1 });

      const req = h.agent.requests[1];
      expect(req).toMatchObject({ round: 2 });
      expect(req?.inputs.diff).toContain('src/fixed.ts');
      expect(req?.inputs.diff).not.toContain('export const f1'); // already reviewed in round 1
      expect(req?.inputs.previousFindings?.map((f) => f.id).sort()).toEqual(round1.map((f) => f.id).sort());
      expect(req?.inputs.previousFindings?.[0]).toMatchObject({ severity: expect.any(String), file: 'src/f1.ts' });

      // Stored per round, and the previous findings were resolved as reported.
      expect((await rows(t.id, 2)).map((f) => f.issue)).toEqual(['Nit']);
      const after1 = await rows(t.id, 1);
      expect(after1.find((f) => f.id === round1[0]?.id)?.status).toBe('fixed');
      expect(after1.find((f) => f.id === round1[1]?.id)?.status).toBe('open');
      expect((await h.reloadTicket(t.id)).reviewRound).toBe(2);
    });

    it('a previous finding the stage does not mention stays open, and unknown ids are ignored', async () => {
      const t = await withWork();
      h.agent.scripts.review = () => review([finding(), finding({ issue: 'Second' })]);
      await service.runRound(t);
      const round1 = await rows(t.id, 1);
      h.write(h.ws(t), 'src/next.ts', 'x\n');
      await h.workspaces.commit(t.id, 'fix: next');
      h.agent.scripts.review = () => review([], [{ id: round1[0]?.id, status: 'fixed' }, { id: 'not-a-real-id', status: 'fixed' }]);
      const res = await service.runRound(await h.reloadTicket(t.id));
      expect(res).toMatchObject({ fixed: 1, stillOpen: 1 });
      expect((await rows(t.id, 1)).map((f) => f.status).sort()).toEqual(['fixed', 'open']);
    });
  });

  describe('limits', () => {
    it('more than 10 findings fails the attempt (retried once), then holds', async () => {
      const t = await withWork();
      h.agent.scripts.review = () => review(Array.from({ length: 11 }, (_, i) => finding({ issue: `Issue ${i}` })));
      const res = await service.runRound(t);
      expect(res).toMatchObject({ kind: 'outcome', outcome: { kind: 'hold', reason: 'needs_help' } });
      expect(((res as { outcome: { note: string } }).outcome).note).toContain('11 findings is more than the limit of 10');
      expect(await rows(t.id)).toEqual([]);
      expect((await h.reloadTicket(t.id)).reviewRound).toBe(0);
    });

    it('exactly 10 is fine, and a retry that obeys the limit succeeds', async () => {
      const t = await withWork();
      h.agent.scripts.review = ({ attempt }) => review(Array.from({ length: attempt === 1 ? 12 : 10 }, (_, i) => finding({ issue: `Issue ${i}` })));
      expect(await service.runRound(t)).toMatchObject({ kind: 'reviewed', round: 1 });
      expect(await rows(t.id)).toHaveLength(10);
    });

    it('above reviewMaxDiffLines the stage gets the diff stat and the range instead of the diff', async () => {
      await h.setProject({ settings: { limits: { reviewMaxDiffLines: 100 } } });
      const t = await withWork();
      h.write(h.ws(t), 'src/big.ts', Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
      await h.workspaces.commit(t.id, 'feat: big');
      h.agent.scripts.review = () => review([]);
      await service.runRound(t);
      const req = h.agent.requests[0];
      expect(req?.inputs.diff).toBeUndefined();
      expect(req?.inputs.diffStat).toContain('src/big.ts');
      expect(req?.inputs.diffRange).toBe('origin/dev...HEAD');
      expect(req?.inputs.diffLines).toBeGreaterThan(100);
    });

    it('lockfile and dist changes do not count towards the size or appear in the diff', async () => {
      const t = await withWork();
      h.write(h.ws(t), 'package-lock.json', JSON.stringify({ x: 'y'.repeat(50) }) + '\n');
      h.write(h.ws(t), 'dist/out.js', 'bundle\n');
      await h.workspaces.commit(t.id, 'chore: lock and dist');
      h.agent.scripts.review = () => review([]);
      await service.runRound(t);
      expect(h.agent.requests[0]?.inputs.diff).not.toContain('package-lock.json');
      expect(h.agent.requests[0]?.inputs.diff).not.toContain('dist/out.js');
    });
  });

  it('turns a failed, killed or question-asking stage into the documented hold', async () => {
    const t = await withWork();
    h.agent.override = { kind: 'killed', stageRunId: 'x', attempts: 1 };
    expect(await service.runRound(t)).toMatchObject({ kind: 'outcome', outcome: { kind: 'hold', reason: 'manual' } });
    h.agent.override = { kind: 'failed', reason: 'bad output', stageRunId: 'x', attempts: 2 };
    expect(await service.runRound(t)).toMatchObject({ kind: 'outcome', outcome: { kind: 'hold', reason: 'needs_help' } });
    expect((await h.reloadTicket(t.id)).reviewRound).toBe(0);
  });

  it('openFindings returns only the open ones of a round', async () => {
    const t = await withWork();
    h.agent.scripts.review = () => review([finding(), finding({ issue: 'b' })]);
    await service.runRound(t);
    const [first] = await rows(t.id, 1);
    await h.prisma.reviewFinding.update({ where: { id: first?.id as string }, data: { status: 'fixed' } });
    expect(await service.openFindings(t.id, 1)).toHaveLength(1);
    expect(await service.openFindings(t.id, 2)).toEqual([]);
  });
});
