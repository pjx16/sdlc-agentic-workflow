import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { SubtaskStepsService } from './subtask-steps.service';

const done = (testFiles: string[]): StageEnvelope => ({ status: 'done', summary: 'tests', data: { testFiles, criteriaCovered: [] } as never });

describe('verify-red and the test commit (F9)', () => {
  let h: StepsHarness;
  let steps: SubtaskStepsService;

  const writesTests = (name = 'f1') => ({ ws }: { ws: string }) => {
    h.write(ws, `src/${name}.test.ts`, `import { ${name} } from './${name}';\n`);
    return done([`src/${name}.test.ts`]);
  };
  /** A ticket with a subtask whose tests were just written (status VERIFY_RED). */
  const atRed = async (files = ['src/f1.test.ts']) => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1, { status: 'VERIFY_RED', testFiles: files });
    for (const f of files) h.write(h.ws(t), f, 'test');
    return { t, s };
  };

  beforeAll(async () => {
    h = await StepsHarness.create();
    steps = new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config, h.pr);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.engine.reset();
    h.agent.requests = [];
    h.agent.override = null;
    await h.setProject({ typecheckCmd: 'npx tsc --noEmit', installCmd: 'npm ci', settings: {} });
  });

  it('a valid red commits test(<KEY>): <title>, records testCommit, and moves to IMPLEMENT', async () => {
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['FAIL src/f1.test.ts', 'AssertionError: expected undefined to be 1'] }];
    const { t, s } = await atRed();
    expect(await steps.verifyRed(t, s)).toEqual({ kind: 'continue' });
    const after = await h.reload(s.id);
    expect(after.status).toBe('IMPLEMENT');
    const ws = h.ws(t);
    expect(sh(ws, 'log', '-1', '--format=%s')).toBe(`test(${t.key}): Subtask 1`);
    expect(sh(ws, 'log', '-1', '--format=%an <%ae>')).toBe('Dev Bot <bot@example.com>');
    expect(after.testCommit).toBe(sh(ws, 'rev-parse', 'HEAD'));
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/f1.test.ts');
  });

  it('runs the typecheck, then only the targeted tests with the listed files quoted into the template', async () => {
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['expected 1'] }];
    const { t, s } = await atRed(['src/a b.test.ts']);
    await steps.verifyRed(t, s);
    expect(h.engine.commands.filter((c) => !/npm ci/.test(c))).toEqual(['npx tsc --noEmit', "npx vitest run 'src/a b.test.ts'"]);
  });

  describe('an invalid red re-runs the tests stage once, then holds (needs_help)', () => {
    const invalid = (name: string, rules: Parameters<typeof h.engine.reset> extends [] ? { match: RegExp; exitCode: number; lines?: string[] }[] : never, expected: string) =>
      it(name, async () => {
        h.engine.rules = rules;
        const { t, s } = await atRed();
        expect(await steps.verifyRed(t, s)).toEqual({ kind: 'continue' });
        const after = await h.reload(s.id);
        expect(after).toMatchObject({ status: 'TESTS', testCommit: null });
        expect(after.lastFailure).toContain(expected);
        expect(sh(h.ws(t), 'log', '-1', '--format=%s')).not.toContain('test(');
      });
    invalid('the tests pass', [{ match: /vitest/, exitCode: 0, lines: ['1 passed'] }], 'must fail before the implementation exists');
    invalid('the typecheck fails', [{ match: /tsc/, exitCode: 2, lines: ['src/f1.test.ts(1,1): error TS2307'] }], 'the typecheck fails');
    invalid('module not found', [{ match: /vitest/, exitCode: 1, lines: ["Error: Cannot find module './f1'"] }], 'an error in the tests themselves');
    invalid('syntax error', [{ match: /vitest/, exitCode: 1, lines: ['SyntaxError: Unexpected token'] }], 'SyntaxError');
    invalid('a TypeScript error in the output', [{ match: /vitest/, exitCode: 1, lines: ['error TS2345: bad argument'] }], 'error TS[0-9]+');
    invalid('the tests time out', [{ match: /vitest/, exitCode: 124, lines: [] }], 'timed out');
  });

  it('retries the tests stage once with the reason, and a second invalid red holds the ticket', async () => {
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ["Error: Cannot find module './f1'"] }];
    h.agent.scripts.tests = writesTests();
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    // First pass: tests stage, then verify-red (invalid) -> back to TESTS.
    await steps.tests(t, s);
    expect(await steps.verifyRed(t, await h.reload(s.id))).toEqual({ kind: 'continue' });
    expect((await h.reload(s.id)).status).toBe('TESTS');
    // Retry: the stage is told why, as round 1.
    await steps.tests(t, await h.reload(s.id));
    expect(h.agent.requests[1]).toMatchObject({ round: 1 });
    expect(h.agent.requests[1]?.inputs.previousAttempt).toContain("Cannot find module");
    // Second invalid red: hold.
    const out = await steps.verifyRed(t, await h.reload(s.id));
    expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((out as { note: string }).note).toContain('still invalid after the retry');
    expect((await h.reload(s.id)).status).toBe('VERIFY_RED');
  });

  it('a valid red on the retry works normally and clears the failure note', async () => {
    h.agent.scripts.tests = writesTests();
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ["Cannot find module './f1'"] }];
    await steps.tests(t, s);
    await steps.verifyRed(t, await h.reload(s.id));
    await steps.tests(t, await h.reload(s.id));
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['AssertionError: expected 1'] }];
    await steps.verifyRed(t, await h.reload(s.id));
    expect(await h.reload(s.id)).toMatchObject({ status: 'IMPLEMENT', lastFailure: null });
  });

  describe('empty commands are skipped with a warning (F2)', () => {
    it('an empty typecheck command is skipped, and the red decision uses the tests only', async () => {
      await h.setProject({ typecheckCmd: '' });
      h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['AssertionError'] }];
      const { t, s } = await atRed();
      await steps.verifyRed(t, s);
      expect(h.engine.ran(/tsc/)).toEqual([]);
      expect((await h.reload(s.id)).status).toBe('IMPLEMENT');
      expect((await h.prisma.event.findMany({ where: { ticketId: t.id, type: 'git' } })).some((e) => e.message.includes('typecheck command is empty'))).toBe(true);
    });
  });

  it('installs dependencies again first when package.json changed', async () => {
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['expected 1'] }];
    const { t, s } = await atRed();
    h.write(h.ws(t), 'package.json', '{"name":"target","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n');
    await steps.verifyRed(t, s);
    expect(h.engine.commands[0]).toBe('npm ci');
    const second = await h.subtask(t.id, 2, { status: 'VERIFY_RED', testFiles: ['src/f1.test.ts'] });
    h.engine.commands.length = 0;
    await steps.verifyRed(t, second);
    expect(h.engine.ran(/npm ci/)).toEqual([]); // already installed for this manifest
  });

  it('holds when that install fails', async () => {
    h.engine.rules = [{ match: /npm ci/, exitCode: 1, lines: ['npm ERR! 404 left-pad'] }];
    const { t, s } = await atRed();
    h.write(h.ws(t), 'package.json', '{"name":"target","dependencies":{"x":"1"}}\n');
    const out = await steps.verifyRed(t, s);
    expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((out as { note: string }).note).toContain('npm ERR! 404');
    expect((await h.reload(s.id)).status).toBe('VERIFY_RED');
  });

  it('holds a subtask that has no test files', async () => {
    const t = await h.ticket();
    expect(await steps.verifyRed(t, await h.subtask(t.id, 1, { status: 'VERIFY_RED', testFiles: [] }))).toMatchObject({ kind: 'hold', reason: 'needs_help' });
  });

  it('flattens a multi-line subtask title in the commit message', async () => {
    h.engine.rules = [{ match: /vitest/, exitCode: 1, lines: ['expected 1'] }];
    const { t, s } = await atRed();
    await h.prisma.subtask.update({ where: { id: s.id }, data: { title: 'Add export\n\nCo-Authored-By: someone' } });
    await steps.verifyRed(t, await h.reload(s.id));
    // The guard refuses attribution; the title was flattened to one line so the trailer is no longer a trailer.
    expect(sh(h.ws(t), 'log', '-1', '--format=%B').trim()).toBe(`test(${t.key}): Add export Co-Authored-By: someone`);
  });
});
