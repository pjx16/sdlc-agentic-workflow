import 'reflect-metadata';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { SubtaskStepsService } from './subtask-steps.service';

const impl = (): StageEnvelope => ({ status: 'done', summary: 'changed', data: { filesChanged: ['src/f1.ts'] } as never });

describe('commit guard and agent-made commits in the subtask stages (F9)', () => {
  let h: StepsHarness;
  let steps: SubtaskStepsService;

  const atImplement = async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1, { status: 'IMPLEMENT', testFiles: [], testCommit: 'x' });
    return { t, s, ws: h.ws(t) };
  };

  beforeAll(async () => {
    h = await StepsHarness.create();
    steps = new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config, h.pr);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(() => {
    h.engine.reset();
    h.agent.requests = [];
    h.agent.override = null;
  });

  it('a stage that leaves an .env file behind fails the attempt; a clean second attempt succeeds', async () => {
    const { t, s } = await atImplement();
    h.agent.scripts.implement = ({ ws, attempt }) => {
      h.write(ws, 'src/f1.ts', 'export const f1 = 1;\n');
      if (attempt === 1) h.write(ws, '.env', 'SECRET=1');
      else rmSync(path.join(ws, '.env'), { force: true }); // the second attempt cleans up
      return impl();
    };
    expect(await steps.implement(t, s)).toEqual({ kind: 'continue' });
    const runs = await h.prisma.stageRun.findMany({ where: { subtaskId: s.id }, orderBy: { attempt: 'asc' } });
    expect(runs.map((r) => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect(runs[0]?.error).toContain('.env');
  });

  it.each([
    ['node_modules', 'node_modules/leftover/index.js', 'x'],
    ['a key file', 'certs/server.pem', '-----BEGIN-----'],
    ['a file over 1 MB', 'data/dump.bin', 'a'.repeat(1024 * 1024 + 1)],
  ])('%s left behind on every attempt holds the ticket (needs_help)', async (_name, file, content) => {
    const { t, s } = await atImplement();
    h.agent.scripts.implement = ({ ws }) => {
      h.write(ws, file, content);
      return impl();
    };
    const out = await steps.implement(t, s);
    expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((out as { note: string }).note).toContain(file);
    expect((await h.reload(s.id)).status).toBe('IMPLEMENT');
  });

  it('applies to the tests and fix stages too', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    h.agent.scripts.tests = ({ ws }) => {
      h.write(ws, 'src/a.test.ts', 'x');
      h.write(ws, '.env.local', 'S=1');
      return { status: 'done', summary: 's', data: { testFiles: ['src/a.test.ts'], criteriaCovered: [] } as never };
    };
    expect(await steps.tests(t, s)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    const f = await h.subtask(t.id, 2, { status: 'FIXING', lastFailure: 'x' });
    h.agent.scripts.fix = ({ ws }) => {
      h.write(ws, 'signing.key', 'k');
      return impl();
    };
    expect(await steps.fix(t, f)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
  });

  it('commits the agent made inside a stage are squashed back, leaving the work uncommitted for the orchestrator', async () => {
    const { t, s, ws } = await atImplement();
    const pre = sh(ws, 'rev-parse', 'HEAD');
    h.agent.scripts.implement = ({ ws: w }) => {
      h.write(w, 'src/f1.ts', 'export const f1 = 1;\n');
      sh(w, 'add', '.');
      sh(w, 'commit', '-q', '-m', 'agent: implement');
      h.write(w, 'src/extra.ts', 'export const extra = 1;\n');
      sh(w, 'add', '.');
      sh(w, 'commit', '-q', '-m', 'agent: more');
      return impl();
    };
    await steps.implement(t, s);
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(pre);
    expect(sh(ws, 'status', '--porcelain').split('\n').sort()).toEqual(['A  src/extra.ts', 'A  src/f1.ts']);
    expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('the agent made 2 commit(s) of its own'))).toBe(true);
  });

  it('a secret committed by the agent is caught at the orchestrator commit', async () => {
    const t = await h.ticket();
    const ws = h.ws(t);
    const pre = sh(ws, 'rev-parse', 'HEAD');
    h.write(ws, 'src/ok.ts', 'ok');
    h.write(ws, '.env', 'S=1');
    sh(ws, 'add', '-f', '.');
    sh(ws, 'commit', '-q', '-m', 'agent');
    const { squashAgentCommits } = await import('../git/commit-guard');
    await squashAgentCommits(h.git, ws, pre);
    await expect(h.workspaces.commit(t.id, 'feat: x')).rejects.toThrow(/commit guard refused/);
  });
});
