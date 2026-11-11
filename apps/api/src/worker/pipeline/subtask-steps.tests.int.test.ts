import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { SubtaskStepsService } from './subtask-steps.service';

const done = (testFiles: string[]): StageEnvelope => ({ status: 'done', summary: 'tests written', data: { testFiles, criteriaCovered: testFiles.map((t) => ({ criterion: 'c', test: t })) } as never });

describe('tests stage (F9)', () => {
  let h: StepsHarness;
  let steps: SubtaskStepsService;

  beforeAll(async () => {
    h = await StepsHarness.create();
    steps = new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(() => {
    h.agent.requests = [];
    h.agent.override = null;
  });

  it('runs the stage, records the test files, and moves the subtask to VERIFY_RED', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    h.agent.scripts.tests = ({ ws }) => {
      h.write(ws, 'src/f1.test.ts', "import { f1 } from './f1';\n");
      h.write(ws, 'src/f1.ts', 'export const f1 = () => { throw new Error("not implemented"); };\n'); // a stub
      return done(['src/f1.test.ts']);
    };
    expect(await steps.tests(t, s)).toEqual({ kind: 'continue' });
    expect(await h.reload(s.id)).toMatchObject({ status: 'VERIFY_RED', testFiles: ['src/f1.test.ts'] });
    const req = h.agent.requests[0];
    expect(req).toMatchObject({ stage: 'tests', subtaskId: s.id, round: 0 });
    expect(req?.inputs.exampleTestFile).toBe('src/app.test.ts');
    expect(req?.inputs.subtask).toMatchObject({ seq: 1, title: 'Subtask 1', acceptanceCriteria: ['criterion 1'], files: ['src/f1.ts'] });
    expect(req?.inputs.plan).toBe('# Plan');
  });

  it('sets the subtask to TESTS while the stage runs', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    let during = '';
    h.agent.scripts.tests = async ({ ws }) => {
      during = (await h.reload(s.id)).status;
      h.write(ws, 'src/a.test.ts', 'x');
      return done(['src/a.test.ts']);
    };
    await steps.tests(t, s);
    expect(during).toBe('TESTS');
  });

  describe('orchestrator checks on testFiles fail the attempt (and the stage retries once)', () => {
    it('a listed file that does not exist', async () => {
      const t = await h.ticket();
      const s = await h.subtask(t.id, 1);
      h.agent.scripts.tests = () => done(['src/ghost.test.ts']);
      const out = await steps.tests(t, s);
      expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect((out as { note: string }).note).toContain('"src/ghost.test.ts" does not exist');
      expect((await h.reload(s.id)).status).toBe('TESTS'); // not advanced
    });

    it('a listed file that is not a test file', async () => {
      const t = await h.ticket();
      const s = await h.subtask(t.id, 1);
      h.agent.scripts.tests = ({ ws }) => {
        h.write(ws, 'src/impl.ts', 'x');
        return done(['src/impl.ts']);
      };
      expect(((await steps.tests(t, s)) as { note: string }).note).toContain('does not match the test file patterns');
    });

    it('a new test file that was not listed', async () => {
      const t = await h.ticket();
      const s = await h.subtask(t.id, 1);
      h.agent.scripts.tests = ({ ws }) => {
        h.write(ws, 'src/listed.test.ts', 'x');
        h.write(ws, 'tests/forgot.ts', 'x');
        return done(['src/listed.test.ts']);
      };
      expect(((await steps.tests(t, s)) as { note: string }).note).toContain('not listed in testFiles: tests/forgot.ts');
    });

    it('a modified existing test file that was not listed', async () => {
      const t = await h.ticket();
      const s = await h.subtask(t.id, 1);
      h.agent.scripts.tests = ({ ws }) => {
        h.write(ws, 'src/app.test.ts', 'modified');
        h.write(ws, 'src/new.test.ts', 'x');
        return done(['src/new.test.ts']);
      };
      expect(((await steps.tests(t, s)) as { note: string }).note).toContain('src/app.test.ts');
    });

    it('an empty list', async () => {
      h.agent.scripts.tests = () => done([]);
      const t = await h.ticket();
      expect(((await steps.tests(t, await h.subtask(t.id, 1))) as { note: string }).note).toContain('testFiles is empty');
    });

    it('a second attempt that fixes the problem succeeds', async () => {
      const t = await h.ticket();
      const s = await h.subtask(t.id, 1);
      h.agent.scripts.tests = ({ ws, attempt }) => {
        h.write(ws, 'src/ok.test.ts', 'x');
        return done(attempt === 1 ? ['src/missing.test.ts'] : ['src/ok.test.ts']);
      };
      expect(await steps.tests(t, s)).toEqual({ kind: 'continue' });
      expect(h.agent.requests).toHaveLength(1); // one launch; the runner retried inside it
      expect((await h.prisma.stageRun.findMany({ where: { subtaskId: s.id }, orderBy: { attempt: 'asc' } })).map((r) => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    });
  });

  it('on a retry after an invalid red, the stage runs as round 1', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    h.agent.scripts.tests = ({ ws }) => {
      h.write(ws, 'src/r.test.ts', 'x');
      return done(['src/r.test.ts']);
    };
    await steps.tests(t, s);
    await h.prisma.subtask.update({ where: { id: s.id }, data: { status: 'TESTS' } }); // verify-red sent it back
    await steps.tests(t, await h.reload(s.id));
    expect(h.agent.requests.map((r) => r.round)).toEqual([0, 1]);
  });

  it('turns a stage that fails, asks a question or is killed into the documented hold', async () => {
    const t = await h.ticket();
    h.agent.override = { kind: 'turn_limit', stageRunId: 'x', attempts: 1 };
    expect(await steps.tests(t, await h.subtask(t.id, 1))).toMatchObject({ kind: 'hold', reason: 'needs_help', note: 'The tests stage reached its turn limit' });
    h.agent.override = { kind: 'killed', stageRunId: 'x', attempts: 1 };
    expect(await steps.tests(t, await h.subtask(t.id, 2))).toMatchObject({ kind: 'hold', reason: 'manual' });
  });

  it('leaves the workspace writable for the agent', async () => {
    const t = await h.ticket();
    h.agent.scripts.tests = ({ ws }) => {
      h.write(ws, 'src/w.test.ts', 'x');
      return done(['src/w.test.ts']);
    };
    await steps.tests(t, await h.subtask(t.id, 1));
    expect(sh(h.ws(t), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`feature/${t.key}-export-bookings`);
  });
});
