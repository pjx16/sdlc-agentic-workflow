import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness } from '../../testing/steps-harness';
import { InProgressHandler } from './in-progress.handler';
import { SubtaskStepsService } from './subtask-steps.service';
import type { StepOutcome } from './step-handler';

describe('draft PR and its description (F9, BUILD_PLAN 6.3 and 6.9)', () => {
  let h: StepsHarness;
  let handler: InProgressHandler;
  const GH = 'https://github.com/acme/billing';

  const scripts = () => {
    h.agent.scripts.tests = ({ ws, req }) => {
      const n = (req.inputs.subtask as { seq: number }).seq;
      h.write(ws, `src/f${n}.test.ts`, 'x');
      return { status: 'done', summary: 't', data: { testFiles: [`src/f${n}.test.ts`], criteriaCovered: [] } as never } as StageEnvelope;
    };
    h.agent.scripts.implement = ({ ws, req }) => {
      const n = (req.inputs.subtask as { seq: number }).seq;
      h.write(ws, `src/f${n}.ts`, `export const f${n} = ${n};\n`);
      return { status: 'done', summary: 'i', data: { filesChanged: [] } as never } as StageEnvelope;
    };
  };
  /** Red once (before the implementation exists), then green. */
  const redThenGreen = () => {
    let phase = new Map<string, number>();
    h.engine.rules = [{ match: /vitest/, compute: (cmd) => { const k = /f\d+\.test\.ts/.exec(cmd)?.[0] ?? ''; const n = (phase.get(k) ?? 0) + 1; phase.set(k, n); return n === 1 ? { exitCode: 1, lines: ['AssertionError: expected'] } : { exitCode: 0, lines: ['passed'] }; } }];
    phase = new Map();
  };
  const step = async (ticketId: string): Promise<StepOutcome> => handler.run(await h.reloadTicket(ticketId));
  /** Runs steps until the given subtask is DONE. */
  const until = async (ticketId: string, subtaskId: string) => {
    for (let i = 0; i < 20 && (await h.reload(subtaskId)).status !== 'DONE'; i++) await step(ticketId);
  };

  beforeAll(async () => {
    h = await StepsHarness.create();
    handler = new InProgressHandler(h.prisma, new SubtaskStepsService(h.prisma, h.launcher, h.outcomes, h.workspaces, h.git, h.verify, h.config, h.pr));
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.engine.reset();
    h.agent.requests = [];
    h.github.reset();
    await h.setProject({ repoUrl: `file://${h.bare}`, typecheckCmd: '', installCmd: '', settings: {} });
    scripts();
    redThenGreen();
  });

  it('opens a draft PR after the first subtask (not before), against the base branch, and stores its number and URL', async () => {
    const t = await h.ticket();
    await h.setProject({ repoUrl: GH });
    const s1 = await h.subtask(t.id, 1);
    await h.subtask(t.id, 2);
    // Before the first subtask is done there is no PR.
    for (let i = 0; i < 3; i++) await step(t.id);
    expect(h.github.opened).toHaveLength(0);
    await until(t.id, s1.id);

    expect(h.github.opened).toHaveLength(1);
    const pr = h.github.opened[0];
    expect(pr).toMatchObject({ repo: 'acme/billing', base: 'dev', head: `feature/${t.key}-export-bookings`, title: `${t.key}: Export bookings` });
    expect(await h.reloadTicket(t.id)).toMatchObject({ prNumber: 100, prUrl: 'https://github.com/acme/billing/pull/100' });
    expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('Opened draft PR #100'))).toBe(true);
  });

  it('the description follows the template, with the finished subtask and its commit and the unfinished one in progress', async () => {
    const t = await h.ticket({ body: 'Customers want a CSV export.' });
    await h.setProject({ repoUrl: GH });
    const s1 = await h.subtask(t.id, 1, { acceptanceCriteria: ['Exports all bookings'] });
    await h.subtask(t.id, 2, { acceptanceCriteria: ['Has an endpoint'] });
    await until(t.id, s1.id);
    const body = h.github.opened[0]?.body as string;
    expect([...body.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['Summary', 'Problem', 'Fix implemented', 'Test plan', 'Review notes']);
    expect(body).toContain(`Export bookings — ${t.key}`);
    expect(body).toContain('Customers want a CSV export.');
    expect(body).toMatch(/- Subtask 1 \(`[0-9a-f]{8}`\)/);
    expect(body).toContain('- Subtask 2 (in progress)');
    expect(body).toContain('- Exports all bookings');
    expect(body).toContain('Targeted test command: `npx vitest run {files}`');
    expect(body).toContain('## Review notes\nnone');
  });

  it('opens it only once, even as more subtasks finish', async () => {
    const t = await h.ticket();
    await h.setProject({ repoUrl: GH });
    await h.subtask(t.id, 1);
    const s2 = await h.subtask(t.id, 2);
    await until(t.id, s2.id);
    expect(h.github.opened).toHaveLength(1);
    expect(h.github.calls.filter((c) => c === 'openDraftPr')).toHaveLength(1);
  });

  it('with pr.earlyDraft off, the PR opens after the last subtask instead', async () => {
    const t = await h.ticket(); // created first, so the workspace's origin is the local bare repository
    await h.setProject({ repoUrl: GH, settings: { pr: { earlyDraft: false } } });
    const s1 = await h.subtask(t.id, 1);
    const s2 = await h.subtask(t.id, 2);
    await until(t.id, s1.id);
    expect(h.github.opened).toHaveLength(0); // not after the first
    await until(t.id, s2.id);
    expect(h.github.opened).toHaveLength(0); // not yet: opens when everything is done
    const out = await step(t.id);
    expect(out).toMatchObject({ kind: 'transition', to: 'REVIEW' });
    expect(h.github.opened).toHaveLength(1);
    expect((h.github.opened[0] as { body: string }).body).toMatch(/- Subtask 2 \(`[0-9a-f]{8}`\)/); // both subtasks are finished by then
  });

  it('a GitHub failure is a recorded warning, never blocks the subtask, and the PR opens at the next opportunity', async () => {
    const t = await h.ticket();
    await h.setProject({ repoUrl: GH });
    const s1 = await h.subtask(t.id, 1);
    const s2 = await h.subtask(t.id, 2);
    h.github.failOpenWith = new Error('HTTP 401: bad credentials');
    await until(t.id, s1.id);
    expect((await h.reload(s1.id)).status).toBe('DONE');
    expect((await h.reloadTicket(t.id)).prNumber).toBeNull();
    expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('could not open the draft PR: HTTP 401'))).toBe(true);
    h.github.failOpenWith = null;
    await until(t.id, s2.id);
    expect((await h.reloadTicket(t.id)).prNumber).toBe(100);
  });

  it('a repository that is not on github.com is a recorded warning too', async () => {
    const t = await h.ticket();
    const s = await h.subtask(t.id, 1);
    await until(t.id, s.id); // repoUrl is the local bare repository
    expect(h.github.opened).toHaveLength(0);
    expect((await h.prisma.event.findMany({ where: { ticketId: t.id } })).some((e) => e.message.includes('not a github.com repository URL'))).toBe(true);
  });

  it('describe() can be rebuilt at any time (used when the PR is marked ready)', async () => {
    const t = await h.ticket();
    await h.subtask(t.id, 1, { featCommit: 'a'.repeat(40) });
    expect(await h.pr.describe(t.id)).toContain('- Subtask 1 (`aaaaaaaa`)');
  });
});
