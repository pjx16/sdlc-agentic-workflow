import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import type { StepOutcome } from './step-handler';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { InProgressHandler } from './in-progress.handler';
import { SubtaskStepsService } from './subtask-steps.service';

const bare = (h: StepsHarness, ...args: string[]) => execFileSync('git', ['--git-dir', h.bare, ...args], { encoding: 'utf8' }).trim();

describe('the subtask loop end to end: tests, red, implement, green, feat commit and push (F9)', () => {
  let h: StepsHarness;
  let handler: InProgressHandler;

  /** Scripted agent: tests write a stub that throws; implement replaces it. */
  const scriptAgent = () => {
    h.agent.scripts.tests = ({ ws, req }) => {
      const n = (req.inputs.subtask as { seq: number }).seq;
      h.write(ws, `src/f${n}.ts`, `export const f${n} = () => { throw new Error('not implemented'); };\n`);
      h.write(ws, `src/f${n}.test.ts`, `import { f${n} } from './f${n}';\n`);
      return { status: 'done', summary: 'tests', data: { testFiles: [`src/f${n}.test.ts`], criteriaCovered: [] } as never } as StageEnvelope;
    };
    h.agent.scripts.implement = ({ ws, req }) => {
      const n = (req.inputs.subtask as { seq: number }).seq;
      h.write(ws, `src/f${n}.ts`, `export const f${n} = () => ${n};\n`);
      return { status: 'done', summary: 'implemented', data: { filesChanged: [`src/f${n}.ts`] } as never } as StageEnvelope;
    };
    h.agent.scripts.fix = () => ({ status: 'done', summary: 'fixed', data: { filesChanged: [] } as never }) as StageEnvelope;
  };
  /** The scripted test runner: a test fails while its implementation still throws. */
  const realisticTests = (ws: () => string) => [{
    match: /vitest/,
    compute: (cmd: string) => {
      const n = /f(\d+)\.test\.ts/.exec(cmd)?.[1];
      const impl = n ? path.join(ws(), `src/f${n}.ts`) : '';
      return impl && existsSync(impl) && readFileSync(impl, 'utf8').includes('not implemented') ? { exitCode: 1, lines: [`FAIL src/f${n}.test.ts`, 'Error: not implemented'] } : { exitCode: 0, lines: ['all passed'] };
    },
  }];
  const drive = async (ticketId: string, max = 40): Promise<StepOutcome[]> => {
    const outcomes: StepOutcome[] = [];
    for (let i = 0; i < max; i++) {
      const out = await handler.run(await h.reloadTicket(ticketId));
      outcomes.push(out);
      if (out.kind !== 'continue') break;
    }
    return outcomes;
  };

  beforeAll(async () => {
    h = await StepsHarness.create();
    const steps = new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config, h.pr);
    handler = new InProgressHandler(h.prisma, steps as never);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.engine.reset();
    h.agent.requests = [];
    h.agent.override = null;
    await h.setProject({ typecheckCmd: 'npx tsc --noEmit', installCmd: 'npm ci', settings: {} });
    scriptAgent();
  });

  it('a two-subtask ticket produces four commits in order (test, feat, test, feat), pushed, and ends at REVIEW', async () => {
    const t = await h.ticket();
    const s1 = await h.subtask(t.id, 1);
    const s2 = await h.subtask(t.id, 2, { dependsOn: [1] });
    h.engine.rules = realisticTests(() => h.ws(t));

    const outcomes = await drive(t.id);
    expect(outcomes.at(-1)).toEqual({ kind: 'transition', to: 'REVIEW', reason: 'Every subtask is done' });

    const ws = h.ws(t);
    const log = sh(ws, 'log', '--reverse', '--format=%s', 'dev..HEAD').split('\n');
    expect(log).toEqual([`test(${t.key}): Subtask 1`, `feat(${t.key}): Subtask 1`, `test(${t.key}): Subtask 2`, `feat(${t.key}): Subtask 2`]);
    expect(new Set(sh(ws, 'log', '--format=%an <%ae>', 'dev..HEAD').split('\n'))).toEqual(new Set(['Dev Bot <bot@example.com>']));

    // Each commit contains what it should: tests (and stub) first, then the implementation.
    const files = (rev: string) => sh(ws, 'show', '--name-only', '--format=', rev).split('\n').sort();
    const [r1, r2, r3, r4] = sh(ws, 'log', '--reverse', '--format=%H', 'dev..HEAD').split('\n') as [string, string, string, string];
    expect(files(r1)).toEqual(['src/f1.test.ts', 'src/f1.ts']);
    expect(files(r2)).toEqual(['src/f1.ts']);
    expect(files(r3)).toEqual(['src/f2.test.ts', 'src/f2.ts']);
    expect(files(r4)).toEqual(['src/f2.ts']);

    // Recorded on the subtasks, and pushed to the remote.
    const a = await h.reload(s1.id);
    const b = await h.reload(s2.id);
    expect([a.status, b.status]).toEqual(['DONE', 'DONE']);
    expect([a.testCommit, a.featCommit, b.testCommit, b.featCommit]).toEqual([r1, r2, r3, r4]);
    const branch = `feature/${t.key}-export-bookings`;
    expect(bare(h, 'rev-parse', branch)).toBe(r4);
    expect(bare(h, 'log', '--reverse', '--format=%s', `dev..${branch}`).split('\n')).toEqual(log);
  });

  it('processes subtasks strictly in order and runs exactly one AI stage per step', async () => {
    const t = await h.ticket();
    await h.subtask(t.id, 2);
    await h.subtask(t.id, 1);
    h.engine.rules = realisticTests(() => h.ws(t));
    await drive(t.id);
    expect(h.agent.requests.map((r) => `${r.stage}:${(r.inputs.subtask as { seq: number }).seq}`)).toEqual(['tests:1', 'implement:1', 'tests:2', 'implement:2']);
  });

  it('with the tests stage off there are no test commits: one feat commit per subtask', async () => {
    await h.setProject({ settings: { stages: { tests: { enabled: false } } } });
    const t = await h.ticket();
    await h.subtask(t.id, 1);
    h.agent.scripts.implement = ({ ws }) => {
      h.write(ws, 'src/f1.ts', 'export const f1 = () => 1;\n');
      h.write(ws, 'src/f1.test.ts', 'test');
      return { status: 'done', summary: 'i', data: { filesChanged: [] } as never };
    };
    const outcomes = await drive(t.id);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'transition', to: 'REVIEW' });
    expect(sh(h.ws(t), 'log', '--format=%s', 'dev..HEAD')).toBe(`feat(${t.key}): Subtask 1`);
    expect(h.engine.ran(/vitest/)).toEqual(["npx vitest run 'src/f1.test.ts'"]);
  });

  it('a rejected push holds the ticket (needs_help) without forcing anything, and a later retry pushes', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    h.engine.rules = realisticTests(() => h.ws(t));
    const branch = `feature/${t.key}-export-bookings`;
    // Someone else already pushed a different commit to this branch.
    const other = path.join(h.tmp, 'other');
    execFileSync('git', ['clone', '-q', h.bare, other]);
    sh(other, 'checkout', '-q', '-b', branch);
    h.write(other, 'theirs.txt', 'theirs');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'someone else');
    sh(other, 'push', '-q', 'origin', branch);
    const theirs = bare(h, 'rev-parse', branch);

    const outcomes = await drive(t.id);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((outcomes.at(-1) as { note: string }).note).toContain('rejected');
    expect(bare(h, 'rev-parse', branch)).toBe(theirs); // not overwritten
    const held = await h.reload(s.id);
    expect(held).toMatchObject({ status: 'VERIFY_GREEN', featCommit: null });
    expect(sh(h.ws(t), 'log', '-1', '--format=%s')).toBe(`feat(${t.key}): Subtask 1`); // the commit exists locally
  });

  it('a guard violation at the feat commit holds the ticket and leaves the subtask undone', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1, { status: 'VERIFY_GREEN', testFiles: ['src/f1.test.ts'] });
    h.write(h.ws(t), 'src/f1.test.ts', 'test');
    h.write(h.ws(t), 'src/f1.ts', 'export const f1 = () => 1;\n');
    h.write(h.ws(t), 'secrets.pem', 'k');
    const out = await handler.run(await h.reloadTicket(t.id));
    expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((out as { note: string }).note).toContain('secrets.pem');
    expect((await h.reload(s.id)).status).toBe('VERIFY_GREEN');
  });
});
