import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StateMachine } from '../../state/state-machine.service';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { CiFixHandler } from './ci-fix.handler';
import { CiPoller } from './ci-poller';

describe('CI polling and the CI fix round (F12)', () => {
  let h: StepsHarness;
  let poller: CiPoller;
  let fixer: CiFixHandler;
  let clock = 1_000_000;
  const GH = 'https://github.com/acme/billing';

  const awaitingCi = async (over: Record<string, unknown> = {}) => {
    // The workspace's remote is the local bare repository; the project is then pointed at GitHub (the fake never contacts it).
    await h.setProject({ repoUrl: `file://${h.bare}` });
    const t = await h.ticket({ status: 'AWAITING_CI', prNumber: 7, prUrl: `${GH}/pull/7`, ...over });
    await h.setProject({ repoUrl: GH });
    return t;
  };
  const status = async (id: string) => (await h.reloadTicket(id)).status;

  beforeAll(async () => {
    h = await StepsHarness.create();
    const states = new StateMachine(h.prisma);
    poller = new CiPoller(h.prisma, states, h.pr, h.github, () => clock);
    fixer = new CiFixHandler(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.github);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.github.reset();
    h.agent.requests = [];
    await h.setProject({ repoUrl: GH, installCmd: '', settings: {} });
    // Other tests' tickets must not be looked at.
    await h.prisma.ticket.updateMany({ where: { status: 'AWAITING_CI' }, data: { status: 'DONE' } });
  });

  it('passing checks (and no checks at all) move the ticket on', async () => {
    const t = await awaitingCi();
    h.github.setChecks('pass', 'skipping');
    await poller.check();
    expect(await status(t.id)).toBe('IN_HUMAN_REVIEW');

    const t2 = await awaitingCi();
    h.github.setChecks();
    await poller.check();
    expect(await status(t2.id)).toBe('IN_HUMAN_REVIEW');
  });

  it('pending checks keep waiting, and set the wait start once', async () => {
    const t = await awaitingCi();
    h.github.setChecks('pass', 'pending');
    await poller.check();
    const first = (await h.reloadTicket(t.id)).ciWaitStartedAt;
    expect(first).not.toBeNull();
    clock += 60_000;
    await poller.check();
    expect(await status(t.id)).toBe('AWAITING_CI');
    expect((await h.reloadTicket(t.id)).ciWaitStartedAt).toEqual(first);
  });

  it('checks that never finish hold the ticket (needs_help) after ciTimeoutMin', async () => {
    await h.setProject({ settings: { pr: { ciTimeoutMin: 5 } } });
    const t = await awaitingCi();
    h.github.setChecks('pending');
    await poller.check();
    clock += 4 * 60_000;
    await poller.check();
    expect(await status(t.id)).toBe('AWAITING_CI');
    clock += 2 * 60_000;
    await poller.check();
    const after = await h.reloadTicket(t.id);
    expect(after).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'AWAITING_CI', ciWaitStartedAt: null });
    expect(h.github.ready).toEqual([]);
  });

  it('a failure queues one CI fix round; a second failure holds', async () => {
    const t = await awaitingCi();
    h.github.setChecks('fail');
    await poller.check();
    expect(await h.reloadTicket(t.id)).toMatchObject({ status: 'AWAITING_CI', ciFixPending: true });
    await poller.check(); // a ticket with a pending fix is not polled
    expect(h.github.calls.filter((c) => c === 'checks')).toHaveLength(1);

    await h.prisma.ticket.update({ where: { id: t.id }, data: { ciFixPending: false, ciFixDone: true } });
    await poller.check();
    expect(await h.reloadTicket(t.id)).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help' });
  });

  it('with pr.ciFixRound off a failure holds straight away', async () => {
    await h.setProject({ settings: { pr: { ciFixRound: false } } });
    const t = await awaitingCi();
    h.github.setChecks('fail');
    await poller.check();
    expect(await h.reloadTicket(t.id)).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help', ciFixPending: false });
  });

  it('the CI fix gets the failing log, commits "fix(<KEY>): resolve CI failure", pushes, and the checks are polled again', async () => {
    const t = await awaitingCi({ ciFixPending: true });
    h.github.failLog = 'FAIL src/app.test.ts\nexpected 1 got 2';
    h.agent.scripts.fix = ({ ws }) => {
      h.write(ws, 'src/app.ts', 'export const app = 2;\n');
      return { status: 'done', summary: 'fixed', data: { filesChanged: ['src/app.ts'] } as never } as StageEnvelope;
    };
    const ws = h.ws(t);
    const out = await fixer.run(await h.reloadTicket(t.id));
    expect(out).toEqual({ kind: 'continue' });
    expect(h.agent.requests[0]).toMatchObject({ stage: 'fix', reason: 'ci', inputs: { failureOutput: 'FAIL src/app.test.ts\nexpected 1 got 2' } });
    expect(sh(ws, 'log', '-1', '--format=%s')).toBe(`fix(${t.key}): resolve CI failure`);
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(sh(h.bare, 'rev-parse', t.branch ?? (await h.reloadTicket(t.id)).branch ?? ''));
    expect(await h.reloadTicket(t.id)).toMatchObject({ ciFixPending: false, ciFixDone: true, ciWaitStartedAt: null });
    expect((await h.prisma.stageRun.findFirstOrThrow({ where: { ticketId: t.id, stage: 'fix' } })).reason).toBe('ci');

    h.github.setChecks('pass');
    await poller.check();
    expect(await status(t.id)).toBe('IN_HUMAN_REVIEW');
  });

  it('a CI fix that fails still uses up the round', async () => {
    const t = await awaitingCi({ ciFixPending: true });
    h.agent.scripts.fix = () => ({ status: 'failed', summary: 'could not', data: {} } as never);
    const out = await fixer.run(await h.reloadTicket(t.id));
    expect(out.kind).toBe('hold');
    expect(await h.reloadTicket(t.id)).toMatchObject({ ciFixPending: false, ciFixDone: true });
  });

  it('on pass: marks the PR ready, rewrites the description with the remaining findings, posts the summary, then IN_HUMAN_REVIEW', async () => {
    const t = await awaitingCi({ reviewRound: 2 });
    const f = (round: number, severity: string, status: string) => ({ ticketId: t.id, round, severity, file: 'a.ts', issue: 'i', rule: 'r', fix: 'f', status });
    await h.prisma.reviewFinding.createMany({ data: [f(1, 'high', 'fixed'), f(2, 'medium', 'open'), f(2, 'low', 'open'), f(2, 'low', 'open')] as never });
    h.github.setChecks('pass');
    await poller.check();
    expect(await status(t.id)).toBe('IN_HUMAN_REVIEW');
    expect(h.github.calls.filter((c) => ['markReady', 'editBody', 'comment'].includes(c))).toEqual(['markReady', 'editBody', 'comment']);
    expect(h.github.ready).toEqual([7]);
    expect(h.github.edits[0]?.body).toContain('## Review notes\n1 medium and 2 low finding(s) remain open.');
    expect(h.github.comments[0]?.body).toContain('2 review round(s); 1 finding(s) fixed. Still open: 1 medium, 2 low.');
  });

  it('a GitHub problem while finishing the PR is a warning; the ticket still moves on', async () => {
    const t = await awaitingCi();
    h.github.setChecks('pass');
    h.github.markReady = async () => {
      throw new Error('gh: boom');
    };
    await poller.check();
    expect(await status(t.id)).toBe('IN_HUMAN_REVIEW');
    expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('mark ready: gh: boom'))).toBe(true);
  });
});
