import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { SubtaskStepsService } from './subtask-steps.service';

const impl = (files: string[]): StageEnvelope => ({ status: 'done', summary: 'implemented', data: { filesChanged: files } as never });
const ORIGINAL = "import { f1 } from './f1';\ntest('f1 works', () => expect(f1()).toBe(1));\n";

describe('implement and verify-green (F9)', () => {
  let h: StepsHarness;
  let steps: SubtaskStepsService;

  /** A subtask whose tests are committed (testCommit recorded), waiting to be implemented. */
  const atImplement = async () => {
    const t = await h.ticket();
    h.write(h.ws(t), 'src/f1.test.ts', ORIGINAL);
    await h.workspaces.commit(t.id, `test(${t.key}): Subtask 1`);
    const testCommit = sh(h.ws(t), 'rev-parse', 'HEAD');
    const s = await h.subtask(t.id, 1, { status: 'IMPLEMENT', testFiles: ['src/f1.test.ts'], testCommit });
    return { t, s, ws: h.ws(t), testCommit };
  };

  beforeAll(async () => {
    h = await StepsHarness.create();
    steps = new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.engine.reset();
    h.agent.requests = [];
    h.agent.override = null;
    await h.setProject({ typecheckCmd: 'npx tsc --noEmit', installCmd: 'npm ci', settings: {} });
  });

  describe('implement', () => {
    it('runs the stage with the ticket, plan, subtask, KB doc and test files, then moves to VERIFY_GREEN', async () => {
      const { t, s } = await atImplement();
      h.agent.scripts.implement = ({ ws }) => {
        h.write(ws, 'src/f1.ts', 'export const f1 = () => 1;\n');
        return impl(['src/f1.ts']);
      };
      expect(await steps.implement(t, s)).toEqual({ kind: 'continue' });
      expect((await h.reload(s.id)).status).toBe('VERIFY_GREEN');
      expect(h.agent.requests[0]).toMatchObject({ stage: 'implement', modelAlias: 'haiku', maxTurns: 40, subtaskId: s.id });
      expect(h.agent.requests[0]?.inputs).toMatchObject({ plan: '# Plan', testFiles: ['src/f1.test.ts'], writeTests: false });
      expect(h.agent.requests[0]?.inputs.subtask).toMatchObject({ seq: 1, title: 'Subtask 1' });
    });

    it('with the tests stage off it is told to write tests, and records the test files it changed', async () => {
      await h.setProject({ settings: { stages: { tests: { enabled: false } } } });
      const t = await h.ticket();
      const s = await h.subtask(t.id, 1); // PENDING
      h.agent.scripts.implement = ({ ws }) => {
        h.write(ws, 'src/f1.ts', 'export const f1 = () => 1;\n');
        h.write(ws, 'src/f1.test.ts', 'test');
        return impl(['src/f1.ts', 'src/f1.test.ts']);
      };
      await steps.implement(t, s);
      expect(h.agent.requests[0]?.inputs.writeTests).toBe(true);
      expect(await h.reload(s.id)).toMatchObject({ status: 'VERIFY_GREEN', testFiles: ['src/f1.test.ts'] });
    });

    it('turns a failed stage into a hold', async () => {
      const { t, s } = await atImplement();
      h.agent.override = { kind: 'failed', reason: 'invalid output', stageRunId: 'x', attempts: 2 };
      expect(await steps.implement(t, s)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect((await h.reload(s.id)).status).toBe('IMPLEMENT');
    });
  });

  describe('verify-green', () => {
    it('passes when the typecheck and the targeted tests pass, and the subtask is DONE', async () => {
      const { t, s } = await atImplement();
      await h.prisma.subtask.update({ where: { id: s.id }, data: { status: 'VERIFY_GREEN' } });
      expect(await steps.verifyGreen(t, await h.reload(s.id))).toEqual({ kind: 'continue' });
      expect((await h.reload(s.id)).status).toBe('DONE');
      expect(h.engine.ran(/tsc|vitest/)).toEqual(['npx tsc --noEmit', "npx vitest run 'src/f1.test.ts'"]);
    });

    it('fails when the tests fail, recording the tail of the output', async () => {
      const { t, s } = await atImplement();
      h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['FAIL src/f1.test.ts', 'expected 0 to be 1'] }];
      expect(await steps.verifyGreen(t, await h.reload(s.id))).toEqual({ kind: 'continue' }); // fix rounds follow (7.5)
      expect((await h.reload(s.id)).lastFailure).toBe('FAIL src/f1.test.ts\nexpected 0 to be 1');
      expect((await h.reload(s.id)).status).toBe('FIXING');
    });

    it('fails on a typecheck error without running the tests', async () => {
      const { t, s } = await atImplement();
      h.engine.rules = [{ match: /tsc/, exitCode: 2, lines: ['src/f1.ts(1,1): error TS2322'] }];
      await steps.verifyGreen(t, s);
      expect(h.engine.ran(/vitest/)).toEqual([]);
      expect((await h.reload(s.id)).lastFailure).toContain('error TS2322');
    });

    it('undoes tampering: a modified test file is restored from testCommit and the ORIGINAL tests decide', async () => {
      const { t, s, ws } = await atImplement();
      // The implementation "passes" by rewriting the test so it always succeeds.
      h.write(ws, 'src/f1.test.ts', "test('always passes', () => {});\n");
      // The scripted tests fail unless the test file has its original content when they run.
      h.engine.rules = [{ match: /vitest/, compute: () => (readFileSync(path.join(ws, 'src/f1.test.ts'), 'utf8') === ORIGINAL ? { exitCode: 1, lines: ['original test failed: f1() returned undefined'] } : { exitCode: 0, lines: ['1 passed'] }) }];
      const out = await steps.verifyGreen(t, s);
      expect(readFileSync(path.join(ws, 'src/f1.test.ts'), 'utf8')).toBe(ORIGINAL);
      expect(out).toEqual({ kind: 'continue' }); // the original test decided, and it fails: on to a fix round
      expect((await h.reload(s.id)).status).toBe('FIXING');
      expect((await h.reload(s.id)).lastFailure).toContain('original test failed');
      expect((await h.prisma.event.findMany({ where: { ticketId: t.id, type: 'git' } })).some((e) => e.message.includes('restored test file(s) modified by the implementation: src/f1.test.ts'))).toBe(true);
      expect(sh(ws, 'status', '--porcelain')).toBe('');
    });

    it('restores a test file that was deleted, and one that was committed over by the agent', async () => {
      const { t, s, ws, testCommit } = await atImplement();
      sh(ws, 'rm', '-q', 'src/f1.test.ts');
      await steps.verifyGreen(t, s);
      expect(readFileSync(path.join(ws, 'src/f1.test.ts'), 'utf8')).toBe(ORIGINAL);
      h.write(ws, 'src/f1.test.ts', 'tampered and committed');
      sh(ws, 'add', '.');
      sh(ws, 'commit', '-q', '-m', 'agent commit');
      await steps.verifyGreen(t, await h.reload(s.id));
      expect(readFileSync(path.join(ws, 'src/f1.test.ts'), 'utf8')).toBe(ORIGINAL);
      expect(sh(ws, 'diff', '--name-only', testCommit, '--', 'src/f1.test.ts')).toBe('');
    });

    it('leaves test files alone when the implementation did not touch them', async () => {
      const { t, s } = await atImplement();
      await steps.verifyGreen(t, s);
      expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('restored test file'))).toBe(false);
    });

    it('installs dependencies again first when package.json or a lockfile changed', async () => {
      const { t, s, ws } = await atImplement();
      h.write(ws, 'package-lock.json', '{"lockfileVersion":3}\n');
      await steps.verifyGreen(t, s);
      expect(h.engine.commands[0]).toBe('npm ci');
      h.engine.commands.length = 0;
      await steps.verifyGreen(t, await h.reload(s.id));
      expect(h.engine.ran(/npm ci/)).toEqual([]);
    });

    it('with the tests stage off: runs the changed test files if there are any, otherwise only the typecheck', async () => {
      await h.setProject({ settings: { stages: { tests: { enabled: false } } } });
      const t = await h.ticket();
      const none = await h.subtask(t.id, 1, { status: 'VERIFY_GREEN', testFiles: [] });
      await steps.verifyGreen(t, none);
      expect(h.engine.ran(/vitest/)).toEqual([]);
      expect(h.engine.ran(/tsc/)).toHaveLength(1);
      expect((await h.reload(none.id)).status).toBe('DONE');

      h.engine.commands.length = 0;
      h.write(h.ws(t), 'src/new.test.ts', 'test');
      const some = await h.subtask(t.id, 2, { status: 'VERIFY_GREEN', testFiles: ['src/new.test.ts'] });
      await steps.verifyGreen(t, some);
      expect(h.engine.ran(/vitest/)).toEqual(["npx vitest run 'src/new.test.ts'"]);
    });

    it('with an empty typecheck command, only the tests decide (and a warning is recorded)', async () => {
      await h.setProject({ typecheckCmd: '' });
      const { t, s } = await atImplement();
      expect(await steps.verifyGreen(t, s)).toEqual({ kind: 'continue' });
      expect(h.engine.ran(/tsc/)).toEqual([]);
      expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('typecheck command is empty'))).toBe(true);
    });
  });
});
