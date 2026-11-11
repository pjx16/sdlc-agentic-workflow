import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness } from '../../testing/steps-harness';
import { SubtaskStepsService } from './subtask-steps.service';
import { InProgressHandler } from './in-progress.handler';

const impl = (): StageEnvelope => ({ status: 'done', summary: 'changed', data: { filesChanged: ['src/f1.ts'] } as never });

describe('fix rounds (F9)', () => {
  let h: StepsHarness;
  let steps: SubtaskStepsService;
  let handler: InProgressHandler;

  const atGreen = async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1, { status: 'VERIFY_GREEN', testFiles: ['src/f1.test.ts'] });
    h.write(h.ws(t), 'src/f1.test.ts', 'test');
    return { t, s };
  };
  /** Runs one step of the ticket through the real IN_PROGRESS handler, like the worker loop does. */
  const step = async (ticketId: string) => handler.run(await h.reloadTicket(ticketId));
  const failing = (lines: string[]) => [{ match: /vitest/, exitCode: 1, lines }];

  beforeAll(async () => {
    h = await StepsHarness.create();
    steps = new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config, h.pr);
    handler = new InProgressHandler(h.prisma, steps as never);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.engine.reset();
    h.agent.requests = [];
    h.agent.override = null;
    h.agent.scripts.fix = () => impl();
    await h.setProject({ typecheckCmd: '', installCmd: '', settings: {} });
  });

  it('a verify-green failure sends the subtask to FIXING with the last 60 lines of output', async () => {
    h.engine.rules = failing(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`));
    const { t, s } = await atGreen();
    expect(await steps.verifyGreen(t, s)).toEqual({ kind: 'continue' });
    const after = await h.reload(s.id);
    expect(after.status).toBe('FIXING');
    expect(after.lastFailure?.split('\n')).toHaveLength(60);
    expect(after.lastFailure?.startsWith('line 41')).toBe(true);
    expect(after.fixRounds).toBe(0);
  });

  it('the fix stage gets the failure output and the subtask, runs with reason "tests" and round n, then verify-green repeats', async () => {
    const { t, s } = await atGreen();
    await h.prisma.subtask.update({ where: { id: s.id }, data: { status: 'FIXING', lastFailure: 'expected 0 to be 1' } });
    expect(await steps.fix(t, await h.reload(s.id))).toEqual({ kind: 'continue' });
    expect(h.agent.requests[0]).toMatchObject({ stage: 'fix', modelAlias: 'sonnet', maxTurns: 15, round: 1, reason: 'tests', subtaskId: s.id });
    expect(h.agent.requests[0]?.inputs.failureOutput).toBe('expected 0 to be 1');
    expect(await h.reload(s.id)).toMatchObject({ status: 'VERIFY_GREEN', fixRounds: 1 });
    expect((await h.prisma.stageRun.findMany({ where: { subtaskId: s.id } }))[0]).toMatchObject({ stage: 'fix', reason: 'tests', round: 1 });
  });

  it('a failing implementation runs fix rounds and then holds with needs_help (default two rounds)', async () => {
    h.engine.rules = failing(['FAIL src/f1.test.ts', 'expected 0 to be 1']);
    const { t, s } = await atGreen();
    const trail: string[] = [];
    let out = await step(t.id);
    for (let i = 0; i < 12 && out.kind === 'continue'; i++) {
      trail.push((await h.reload(s.id)).status);
      out = await step(t.id);
    }
    expect(trail).toEqual(['FIXING', 'VERIFY_GREEN', 'FIXING', 'VERIFY_GREEN']);
    expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((out as { note: string }).note).toContain('still fails after 2 fix round(s)');
    expect(h.agent.requests.map((r) => [r.stage, r.round, r.reason])).toEqual([['fix', 1, 'tests'], ['fix', 2, 'tests']]);
    expect(await h.reload(s.id)).toMatchObject({ status: 'VERIFY_GREEN', fixRounds: 2 });
  });

  it('a fix that works lets the subtask finish', async () => {
    const { t, s } = await atGreen();
    let call = 0;
    h.engine.rules = [{ match: /vitest/, compute: () => (++call === 1 ? { exitCode: 1, lines: ['expected 0 to be 1'] } : { exitCode: 0, lines: ['1 passed'] }) }];
    await step(t.id); // verify-green fails -> FIXING
    await step(t.id); // fix
    expect(await step(t.id)).toEqual({ kind: 'continue' }); // verify-green passes
    expect(await h.reload(s.id)).toMatchObject({ status: 'DONE', fixRounds: 1 });
  });

  it('respects maxTestFixRounds: 1 allows one fix, 0 holds at once', async () => {
    h.engine.rules = failing(['boom']);
    await h.setProject({ settings: { limits: { maxTestFixRounds: 1 } } });
    const one = await atGreen();
    await step(one.t.id);
    await step(one.t.id);
    expect(await step(one.t.id)).toMatchObject({ kind: 'hold', reason: 'needs_help' }); // one fix ran, verify-green failed again, no rounds left
    expect((await h.reload(one.s.id)).fixRounds).toBe(1);

    await h.setProject({ settings: { limits: { maxTestFixRounds: 0 } } });
    const zero = await atGreen();
    expect(await step(zero.t.id)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect(h.agent.requests.filter((r) => r.subtaskId === zero.s.id)).toHaveLength(0);
  });

  it('a typecheck failure is fixed the same way', async () => {
    await h.setProject({ typecheckCmd: 'npx tsc --noEmit' });
    h.engine.rules = [{ match: /tsc/, exitCode: 2, lines: ['src/f1.ts(1,1): error TS2322'] }];
    const { t, s } = await atGreen();
    await steps.verifyGreen(t, s);
    expect(await h.reload(s.id)).toMatchObject({ status: 'FIXING' });
    expect((await h.reload(s.id)).lastFailure).toContain('error TS2322');
  });

  it('turns a failed fix stage into a hold', async () => {
    const { t, s } = await atGreen();
    await h.prisma.subtask.update({ where: { id: s.id }, data: { status: 'FIXING', lastFailure: 'x' } });
    h.agent.override = { kind: 'turn_limit', stageRunId: 'x', attempts: 1 };
    expect(await steps.fix(t, await h.reload(s.id))).toMatchObject({ kind: 'hold', reason: 'needs_help', note: 'The fix stage reached its turn limit' });
    expect((await h.reload(s.id)).status).toBe('FIXING');
  });
});
