import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { CiFixHandler } from '../ci/ci-fix.handler';
import { PlanHandler } from '../pipeline/plan.handler';
import { ReviewHandler } from '../review/review.handler';
import { ReviewService } from '../review/review.service';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { OrchestratorService } from './orchestrator.service';

const GH = 'https://github.com/acme/billing';
const answer = (kind: string, reason = 'Because.'): StageEnvelope => ({ status: 'done', summary: 'chose', data: { move: { kind, to: kind }, reason } as never });

/** The decision points other than the knowledge-base update (BUILD_PLAN v1 6.11): each one asks, takes the answer, and falls back to its default. */
describe('the orchestrator at the other decision points', () => {
  let h: StepsHarness;
  let orchestrator: OrchestratorService;
  let review: ReviewHandler;
  let plan: PlanHandler;
  let ci: CiFixHandler;

  const decisions = (ticketId: string) => h.prisma.orchestratorDecision.findMany({ where: { ticketId }, orderBy: { at: 'asc' } });
  const asked = () => h.agent.requests.filter((r) => r.stage === 'orchestrate');

  /** A REVIEW ticket whose first round is done and has one open finding. */
  const reviewed = async (over: Record<string, unknown> = {}) => {
    const t = await h.ticket({ status: 'REVIEW', ...over });
    await h.subtask(t.id, 1, { status: 'DONE' });
    const ws = h.ws(t);
    h.write(ws, 'src/f1.ts', 'export const f1 = (x: string) => x;\n');
    await h.workspaces.commit(t.id, `feat(${t.key}): one`);
    await h.workspaces.push(t.id);
    const head = sh(ws, 'rev-parse', 'HEAD').trim();
    await h.prisma.ticket.update({ where: { id: t.id }, data: { lastReviewedSha: head, reviewRound: (over.reviewRound as number | undefined) ?? 1 } });
    await h.prisma.reviewFinding.create({ data: { ticketId: t.id, round: 1, reviewer: 'prReview', severity: 'high', file: 'src/f1.ts', line: 1, issue: 'Unsafe', rule: 'R', fix: 'Fix it', status: 'open' } });
    return t;
  };

  beforeAll(async () => {
    h = await StepsHarness.create();
    mkdirSync(path.join(h.tmp, 'guidelines'), { recursive: true });
    writeFileSync(path.join(h.tmp, 'guidelines', 'review-checklist.md'), '# Checklist\n');
    orchestrator = new OrchestratorService(h.prisma, h.launcher);
    review = new ReviewHandler(h.prisma, new ReviewService(h.prisma, h.launcher, h.outcomes, h.git, h.config, orchestrator), h.launcher, h.outcomes, h.workspaces, h.git, h.pr, orchestrator);
    plan = new PlanHandler(h.prisma, h.launcher, h.outcomes, {} as never, undefined, orchestrator);
    ci = new CiFixHandler(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.github, undefined, orchestrator);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.agent.requests = [];
    h.agent.override = null;
    h.github.reset();
    h.agent.scripts.fix = ({ ws }) => {
      h.write(ws, 'src/f1.ts', `export const f1 = ${Math.random()};\n`);
      return { status: 'done', summary: 'fixed', data: { filesChanged: ['src/f1.ts'] } as never } as StageEnvelope;
    };
    await h.setProject({ repoUrl: GH, settings: { stages: { qualityReview: { enabled: false }, ciTriage: { enabled: false } } } });
  });

  describe('review_findings', () => {
    it('the orchestrator may send findings to a person instead of the fixer', async () => {
      const t = await reviewed();
      h.agent.scripts.orchestrate = () => answer('support', 'The finding contradicts the plan.');
      const out = await review.run(await h.reloadTicket(t.id));
      expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect((out as { note: string }).note).toContain('contradicts the plan');
      expect(h.agent.requests.some((r) => r.stage === 'fix')).toBe(false);
      expect(await decisions(t.id)).toMatchObject([{ point: 'review_findings', chosen: 'support support', fallbackUsed: false }]);
    });

    it('choosing fix, or failing to answer, runs the fixer; and a person already called in is not asked again', async () => {
      const t = await reviewed();
      h.agent.scripts.orchestrate = () => ({ status: 'blocked', summary: 'x' }) as StageEnvelope;
      expect(await review.run(await h.reloadTicket(t.id))).toEqual({ kind: 'continue' });
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['orchestrate', 'fix']);
      expect((await decisions(t.id))[0]).toMatchObject({ point: 'review_findings', fallbackUsed: true });

      const u = await reviewed();
      h.agent.requests = [];
      h.agent.scripts.orchestrate = () => answer('support');
      await review.run(await h.reloadTicket(u.id));
      h.agent.requests = [];
      expect(await review.run(await h.reloadTicket(u.id))).toEqual({ kind: 'continue' }); // after the person resumed it, the default applies
      expect(asked()).toHaveLength(0);
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['fix']);
    });

    it('with the orchestrator switched off there is no question and the fixer runs', async () => {
      await h.setProject({ repoUrl: GH, settings: { stages: { qualityReview: { enabled: false }, ciTriage: { enabled: false }, orchestrate: { enabled: false } } } });
      const t = await reviewed();
      expect(await review.run(await h.reloadTicket(t.id))).toEqual({ kind: 'continue' });
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['fix']);
    });
  });

  describe('review_limit', () => {
    it('with the rounds used up and a blocking finding left, it may allow one more fix round', async () => {
      const t = await reviewed({ reviewRound: 2 });
      h.agent.scripts.orchestrate = () => answer('extra_round');
      expect(await review.run(await h.reloadTicket(t.id))).toEqual({ kind: 'continue' });
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['orchestrate', 'fix']);
      expect(await decisions(t.id)).toMatchObject([{ point: 'review_limit', chosen: 'extra_round extra_round' }]);
    });

    it('or raise a support ticket that says a re-plan may be needed; the default finishes with the findings listed', async () => {
      const t = await reviewed({ reviewRound: 2 });
      h.agent.scripts.orchestrate = () => answer('support', 'Same finding three times.');
      const out = await review.run(await h.reloadTicket(t.id));
      expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect((out as { note: string }).note).toContain('re-plan');

      const u = await reviewed({ reviewRound: 2 });
      h.agent.scripts.orchestrate = () => answer('finish');
      expect(await review.run(await h.reloadTicket(u.id))).toMatchObject({ kind: 'transition' });
    });
  });

  describe('security_add', () => {
    it('on the first round it may add the security reviewer the code rules did not call', async () => {
      await h.setProject({ repoUrl: GH, settings: { stages: { qualityReview: { enabled: false }, ciTriage: { enabled: false }, securityReview: { enabled: true } } } });
      const t = await h.ticket({ status: 'REVIEW' });
      await h.subtask(t.id, 1, { status: 'DONE' });
      const ws = h.ws(t);
      h.write(ws, 'src/plain.ts', 'export const plain = 1;\n');
      await h.workspaces.commit(t.id, `feat(${t.key}): plain`);
      await h.workspaces.push(t.id);
      h.agent.scripts.orchestrate = () => answer('add', 'It handles money.');
      h.agent.scripts.prReview = () => ({ status: 'done', summary: 'ok', data: { findings: [], previousFindings: [] } as never }) as StageEnvelope;
      h.agent.scripts.securityReview = () => ({ status: 'done', summary: 'ok', data: { findings: [], previousFindings: [] } as never }) as StageEnvelope;
      expect(await review.run(await h.reloadTicket(t.id))).toEqual({ kind: 'continue' });
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['orchestrate', 'prReview', 'securityReview']);
      expect(await decisions(t.id)).toMatchObject([{ point: 'security_add', chosen: 'add add' }]);
    });

    it('by default (skip) the security reviewer does not run', async () => {
      await h.setProject({ repoUrl: GH, settings: { stages: { qualityReview: { enabled: false }, ciTriage: { enabled: false }, securityReview: { enabled: true } } } });
      const t = await h.ticket({ status: 'REVIEW' });
      await h.subtask(t.id, 1, { status: 'DONE' });
      h.write(h.ws(t), 'src/plain.ts', 'export const plain = 1;\n');
      await h.workspaces.commit(t.id, `feat(${t.key}): plain`);
      await h.workspaces.push(t.id);
      h.agent.scripts.orchestrate = () => answer('skip');
      h.agent.scripts.prReview = () => ({ status: 'done', summary: 'ok', data: { findings: [], previousFindings: [] } as never }) as StageEnvelope;
      await review.run(await h.reloadTicket(t.id));
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['orchestrate', 'prReview']);
    });
  });

  describe('chore_plan', () => {
    const chore = (over: Record<string, unknown> = {}) => h.ticket({ status: 'PLANNING', kind: 'chore', title: 'Bump the logger', body: 'Upgrade pino to the latest minor.', ...over });

    it('a chore with the plan gate off may skip planning: the body becomes the plan', async () => {
      await h.setProject({ repoUrl: GH, settings: { gates: { plan: false } } });
      const t = await chore();
      h.agent.scripts.orchestrate = () => answer('skip_plan', 'The body says what to do.');
      const out = await plan.run(t);
      expect(out).toMatchObject({ kind: 'transition', to: 'BREAKDOWN' });
      expect((await h.reloadTicket(t.id)).planMarkdown).toBe('Upgrade pino to the latest minor.');
      expect(await h.prisma.stageArtifact.count({ where: { ticketId: t.id, stage: 'plan' } })).toBe(1);
      expect(h.agent.requests.map((r) => r.stage)).toEqual(['orchestrate']);
    });

    it('with the plan gate on, or for a feature, the question is not asked', async () => {
      await h.setProject({ repoUrl: GH, settings: { gates: { plan: true } } });
      h.agent.scripts.solutionDesign = () => ({ status: 'done', summary: 'p', data: { planMarkdown: '# P', risks: [], openQuestions: [] } as never }) as StageEnvelope;
      await plan.run(await chore());
      expect(asked()).toHaveLength(0);
    });
  });

  describe('ci_flaky', () => {
    const awaitingCi = async () => {
      await h.setProject({ repoUrl: `file://${h.bare}`, settings: { stages: { qualityReview: { enabled: false } } } });
      const t = await h.ticket({ status: 'AWAITING_CI', prNumber: 7, prUrl: `${GH}/pull/7`, ciFixPending: true, ciRerunDone: true });
      await h.setProject({ repoUrl: GH, settings: { stages: { qualityReview: { enabled: false } } } });
      return t;
    };
    const flaky = () => ({ status: 'done', summary: 't', data: { kind: 'flaky', summary: 'timeout in e2e' } as never }) as StageEnvelope;

    it('a second flaky failure raises a support ticket by default, but the orchestrator may allow one more run', async () => {
      const t = await awaitingCi();
      h.agent.scripts.ciTriage = flaky;
      h.agent.scripts.orchestrate = () => answer('rerun', 'It is a known slow test.');
      expect(await ci.run(await h.reloadTicket(t.id))).toEqual({ kind: 'stay' });
      expect(h.github.calls).toContain('rerunFailed');
      expect(await h.prisma.supportTicket.count({ where: { ticketId: t.id, kind: 'ci_infra' } })).toBe(0);

      // Flaky again: the orchestrator has already used its one extra run, so a person is called.
      await h.prisma.ticket.update({ where: { id: t.id }, data: { ciFixPending: true } });
      h.agent.requests = [];
      expect(await ci.run(await h.reloadTicket(t.id))).toMatchObject({ kind: 'hold' });
      expect(asked()).toHaveLength(0);
      expect(await h.prisma.supportTicket.count({ where: { ticketId: t.id, kind: 'ci_infra', status: 'open' } })).toBe(1);
    });

    it('choosing the support ticket, or no answer, calls a person', async () => {
      const t = await awaitingCi();
      h.agent.scripts.ciTriage = flaky;
      h.agent.scripts.orchestrate = () => answer('support');
      expect(await ci.run(await h.reloadTicket(t.id))).toMatchObject({ kind: 'hold' });
      expect(await h.prisma.supportTicket.count({ where: { ticketId: t.id, kind: 'ci_infra', status: 'open' } })).toBe(1);
    });
  });
});

