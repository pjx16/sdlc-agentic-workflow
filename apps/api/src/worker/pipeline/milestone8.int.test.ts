import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StateMachine } from '../../state/state-machine.service';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { CiFixHandler } from '../ci/ci-fix.handler';
import { CiPoller } from '../ci/ci-poller';
import { MergePoller } from '../ci/merge-poller';
import { WorkerLoop } from '../loop/worker-loop';
import { ReviewHandler } from '../review/review.handler';
import { ReviewService } from '../review/review.service';
import { HumanReviewHandler, KbUpdateHandler } from './kb-update.handler';
import { KbUpdateService } from './kb-update.service';

const GH = 'https://github.com/acme/billing';
const finding = (over: Record<string, unknown> = {}) => ({ severity: 'high', file: 'src/f1.ts', line: 1, issue: 'Unvalidated input', rule: 'Security', fix: 'Validate', ...over });

describe('Milestone 8: from the last subtask to a merged PR', () => {
  let h: StepsHarness;
  let loop: WorkerLoop;
  let ci: CiPoller;
  let merge: MergePoller;

  beforeAll(async () => {
    h = await StepsHarness.create();
    mkdirSync(path.join(h.tmp, 'guidelines'), { recursive: true });
    writeFileSync(path.join(h.tmp, 'guidelines', 'review-checklist.md'), '# Checklist\n');
    writeFileSync(path.join(h.tmp, 'guidelines', 'kb-doc-template.md'), '# Template\n');
    const states = new StateMachine(h.prisma);
    const review = new ReviewHandler(h.prisma, new ReviewService(h.prisma, h.launcher, h.outcomes, h.git, h.config), h.launcher, h.outcomes, h.workspaces, h.git, h.pr);
    const kb = new KbUpdateService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.config);
    ci = new CiPoller(h.prisma, states, h.pr, h.github);
    merge = new MergePoller(h.prisma, states, h.github);
    const handlers = [review, new KbUpdateHandler(kb), new HumanReviewHandler(h.prisma, kb), new CiFixHandler(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.github)];
    loop = new WorkerLoop(h.prisma, { clone: async () => undefined } as never, { poll: async () => undefined } as never, { check: async () => undefined } as never, states, handlers, undefined, [ci, merge]);
  }, 180_000);
  afterAll(async () => h?.close());

  it('review finds a high issue, one fix round, a clean second review, a KB update, green CI, ready PR, then merged', async () => {
    // The remote workspace is prepared against the local bare repo, then the project points at GitHub (the fake never contacts it).
    const t = await h.ticket({ status: 'REVIEW', featureKey: 'billing' });
    await h.setProject({ repoUrl: GH, settings: { stages: { qualityReview: { enabled: false }, ciTriage: { enabled: false } } } });
    await h.subtask(t.id, 1, { status: 'DONE' });
    const ws = h.ws(t);
    h.write(ws, 'src/f1.ts', 'export const f1 = (x: string) => x;\n');
    h.write(ws, 'docs/kb/billing.md', '# Billing\noriginal\n');
    h.write(ws, 'docs/kb/features.json', JSON.stringify({ version: 1, features: [{ key: 'billing', title: 'Billing', doc: 'billing.md' }] }));
    await h.workspaces.commit(t.id, `feat(${t.key}): one`);
    await h.workspaces.push(t.id);

    let reviews = 0;
    // Round 1 reports a high and a low finding; round 2 reports the high one fixed and the low one still open.
    h.agent.scripts.prReview = ({ req }) => {
      reviews++;
      const previous = (req.inputs.previousFindings as { id: string; severity: string }[]).map((f) => ({ id: f.id, status: f.severity === 'high' ? 'fixed' : 'still_open' }));
      return { status: 'done', summary: `round ${reviews}`, data: { findings: reviews === 1 ? [finding(), finding({ severity: 'low', issue: 'Name' })] : [], previousFindings: reviews === 1 ? [] : previous } as never } as StageEnvelope;
    };
    h.agent.scripts.fix = ({ ws: w }) => {
      h.write(w, 'src/f1.ts', 'export const f1 = (x: string) => x.trim();\n');
      return { status: 'done', summary: 'fixed', data: { filesChanged: ['src/f1.ts'] } as never } as StageEnvelope;
    };
    h.agent.scripts.kbUpdate = ({ ws: w }) => {
      h.write(w, 'docs/kb/billing.md', '# Billing\nupdated for the export\n');
      return { status: 'done', summary: 'kb', data: { featureKey: 'billing', docPath: 'docs/kb/billing.md', changed: true } as never } as StageEnvelope;
    };
    const tick = async () => loop.tick();
    for (let i = 0; i < 12 && (await h.reloadTicket(t.id)).status !== 'AWAITING_CI'; i++) await tick();
    let cur = await h.reloadTicket(t.id);
    expect(cur.status).toBe('AWAITING_CI');
    expect(cur.reviewRound).toBe(2);

    const subjects = sh(ws, 'log', '--format=%s', `-4`).split('\n');
    expect(subjects.slice(0, 2)).toEqual([`docs(${t.key}): update billing knowledge base`, `fix(${t.key}): address review round 1`]);
    expect(h.github.opened).toHaveLength(1);
    expect(h.github.comments.map((c) => c.body.split('\n')[0])).toEqual(['## Review — round 1', '## Review — round 2']);
    expect(h.github.comments[1]?.body).toContain('Previous findings: 1 fixed, 1 still open.');
    expect(await h.prisma.stageRun.count({ where: { ticketId: t.id, stage: 'fix', reason: 'review' } })).toBe(1);

    h.github.setChecks('pending');
    await ci.check();
    expect((await h.reloadTicket(t.id)).status).toBe('AWAITING_CI');
    h.github.setChecks('pass');
    await ci.check();
    cur = await h.reloadTicket(t.id);
    expect(cur.status).toBe('IN_HUMAN_REVIEW');
    expect(h.github.ready).toEqual([cur.prNumber]);
    expect(h.github.edits.at(-1)?.body).toContain('## Review notes\n0 medium and 1 low finding(s) remain open.');

    h.github.state = { state: 'MERGED', mergedAt: '2026-11-11T12:00:00Z' };
    await merge.check();
    expect((await h.reloadTicket(t.id)).status).toBe('DONE');
  });
});
