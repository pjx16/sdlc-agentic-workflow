import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupportRaiser } from '../../support/support-raiser';
import { StateMachine } from '../../state/state-machine.service';
import { FakeJiraClients } from '../../testing/fake-jira';
import { StepsHarness, sh } from '../../testing/steps-harness';
import { RerunService } from '../../tickets/rerun.service';
import { WorkerLoop } from '../loop/worker-loop';
import { RerunPrep } from './rerun-prep';

const done = (files: string[]): StageEnvelope => ({ status: 'done', summary: 'ok', data: { filesChanged: files } } as StageEnvelope);
const bot = { GIT_AUTHOR_NAME: 'Dev Bot', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'Dev Bot', GIT_COMMITTER_EMAIL: 'bot@example.com' };

describe('commit ranges and the revert before a rerun (BUILD_PLAN v1 6.4 and 6.8)', () => {
  let h: StepsHarness;
  let prep: RerunPrep;
  let reruns: RerunService;
  let states: StateMachine;
  let jira: FakeJiraClients;

  beforeAll(async () => {
    h = await StepsHarness.create();
    states = new StateMachine(h.prisma, []);
    jira = new FakeJiraClients();
    reruns = new RerunService(h.prisma, states, new SupportRaiser(h.prisma), jira);
    prep = new RerunPrep(h.prisma, h.workspaces);
  }, 180_000);
  afterAll(async () => h?.close());

  /** A ticket in REVIEW whose implementation stage ran, edited a file and committed it, as the pipeline does. */
  async function atReview() {
    const t = await h.ticket({ status: 'NEW' });
    for (const s of ['KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW'] as const) await states.transition(t.id, s, 'system', 'on');
    const ws = h.ws(t);
    h.agent.scripts.implement = ({ ws: w }) => {
      h.write(w, 'src/export.ts', 'export const csv = 1;\n');
      return done(['src/export.ts']);
    };
    const start = sh(ws, 'rev-parse', 'HEAD');
    const result = await h.launcher.launch(t, 'implement', { ticket: { key: t.key, title: t.title, body: t.body } }, { workspacePath: ws });
    if (result.kind !== 'done') throw new Error('stage did not finish');
    const committed = await h.workspaces.commit(t.id, `feat(${t.key}): add the export`);
    if (!committed.committed) throw new Error('nothing committed');
    return { t, ws, start, runId: result.stageRunId, commitSha: committed.sha };
  }

  it('a code stage records the head it started from and, once its work is committed, the commit it ended on', async () => {
    const { runId, start, commitSha } = await atReview();
    expect(await h.prisma.stageRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ startSha: start, endSha: commitSha });
    expect(start).not.toBe(commitSha);
  });

  it('a code stage that made no commit records the same sha in both', async () => {
    const t = await h.ticket();
    const ws = h.ws(t);
    h.agent.scripts.fix = () => done([]);
    const result = await h.launcher.launch(t, 'fix', { failureOutput: 'x' }, { workspacePath: ws, reason: 'tests' });
    if (result.kind !== 'done') throw new Error('stage did not finish');
    const head = sh(ws, 'rev-parse', 'HEAD');
    expect(await h.prisma.stageRun.findUniqueOrThrow({ where: { id: result.stageRunId } })).toMatchObject({ startSha: head, endSha: head });
  });

  it('a read-only stage has no commit range', async () => {
    const t = await h.ticket();
    h.agent.scripts.review = () => ({ status: 'done', summary: 'ok', data: { findings: [], previousFindings: [] } } as StageEnvelope);
    const result = await h.launcher.launch(t, 'review', { diff: 'x' }, { workspacePath: h.ws(t) });
    if (result.kind !== 'done') throw new Error('stage did not finish');
    expect(await h.prisma.stageRun.findUniqueOrThrow({ where: { id: result.stageRunId } })).toMatchObject({ startSha: null, endSha: null });
  });

  it('the whole rerun: the plan is sent back, the stale work is reverted with one commit, pushed normally, and the stage then runs', async () => {
    const { t, ws, start, commitSha } = await atReview();
    await h.prisma.supportTicket.create({ data: { kind: 'question', title: 'Which delimiter?', body: 'q', ticketId: t.id, projectId: h.projectId, stage: 'implement' } });
    await jira.jira.comment('X-1', 'warm');

    await reruns.rerun(t.id, { stage: 'PLANNING', note: 'use the existing booking repository' });
    const marked = await h.reloadTicket(t.id);
    expect(marked).toMatchObject({ status: 'PLANNING', revertFromSha: start, revertStage: 'PLANNING' });
    expect((await h.prisma.stageRun.findMany({ where: { ticketId: t.id, stage: 'implement' } })).every((r) => r.supersededAt !== null)).toBe(true);
    expect((await h.prisma.supportTicket.findMany({ where: { ticketId: t.id } })).every((s) => s.status === 'dismissed' || s.status === 'resolved')).toBe(true);
    // Nothing has happened to the workspace yet: the API cannot touch it.
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(commitSha);

    // The worker, before the planning stage runs again:
    expect(await prep.prepare(marked)).toBeNull();
    expect(existsSync(path.join(ws, 'src/export.ts'))).toBe(false);
    expect(sh(ws, 'log', '-1', '--format=%s')).toBe(`revert: drop work superseded by rerun of PLANNING (${t.key})`);
    expect(sh(ws, 'log', '--format=%H')).toContain(commitSha); // history kept
    expect(sh(ws, 'diff', '--stat', start, 'HEAD')).toBe('');
    // Pushed normally: the remote branch has the revert on top of the old work, not a rewritten history.
    const remoteLog = execFileSync('git', ['--git-dir', h.bare, 'log', '--format=%s', marked.branch ?? ''], { encoding: 'utf8' }).trim().split('\n');
    expect(remoteLog[0]).toContain('revert: drop work superseded');
    expect(remoteLog).toContain(`feat(${t.key}): add the export`);
    expect(await h.reloadTicket(t.id)).toMatchObject({ revertFromSha: null, revertStage: null });
    // A second preparation does nothing.
    expect(await prep.prepare(await h.reloadTicket(t.id))).toBeNull();
  });

  it('with commits not made by sdlc-agent in the range, the ticket is held, their commits are named and nothing is reverted', async () => {
    const { t, ws, start } = await atReview();
    h.write(ws, 'src/hotfix.ts', 'by a person\n');
    sh(ws, 'add', '.');
    sh(ws, 'commit', '-q', '-m', 'fix: by hand'); // `sh` commits as someone else
    const human = sh(ws, 'rev-parse', 'HEAD').slice(0, 8);
    const head = sh(ws, 'rev-parse', 'HEAD');

    await reruns.rerun(t.id, { stage: 'PLANNING' });
    const outcome = await prep.prepare(await h.reloadTicket(t.id));
    expect(outcome).toMatchObject({ kind: 'hold', reason: 'needs_help', note: expect.stringContaining(`Branch has commits not made by sdlc-agent: ${human}`) });
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(path.join(ws, 'src/export.ts'))).toBe(true);
    expect(await h.reloadTicket(t.id)).toMatchObject({ revertFromSha: start }); // still pending: tried again on resume
  });

  it('a rejected push holds the ticket and never forces', async () => {
    const { t, ws } = await atReview();
    await h.workspaces.push(t.id); // the pipeline had pushed the work
    // Someone else moved the remote branch on.
    const other = path.join(h.tmp, `other-${t.key}`);
    execFileSync('git', ['clone', '-q', '--branch', (await h.reloadTicket(t.id)).branch ?? '', h.bare, other]);
    h.write(other, 'src/remote-change.ts', 'x\n');
    execFileSync('git', ['add', '.'], { cwd: other });
    execFileSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'remote change'], { cwd: other });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: other });
    await reruns.rerun(t.id, { stage: 'PLANNING' });
    const outcome = await prep.prepare(await h.reloadTicket(t.id));
    expect(outcome).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect(sh(ws, 'log', '-1', '--format=%s')).toContain('revert: drop work superseded'); // the local revert exists; nothing was forced
    expect(execFileSync('git', ['--git-dir', h.bare, 'log', '-1', '--format=%s', (await h.reloadTicket(t.id)).branch ?? ''], { encoding: 'utf8' }).trim()).toBe('remote change');
  });

  it('no stale code to revert means nothing to do', async () => {
    const t = await h.ticket();
    expect(await prep.prepare(t)).toBeNull();
  });

  it('the worker loop runs the preparation before the stage, and holds instead of running when it cannot', async () => {
    const { t, ws } = await atReview();
    h.write(ws, 'src/hotfix2.ts', 'by a person\n');
    sh(ws, 'add', '.');
    sh(ws, 'commit', '-q', '-m', 'fix: by hand again');
    await reruns.rerun(t.id, { stage: 'PLANNING' });
    let stageRan = false;
    const handler = { status: 'PLANNING' as const, async run() { stageRan = true; return { kind: 'continue' as const }; } };
    const loop = new WorkerLoop(h.prisma, {} as never, {} as never, {} as never, states, [handler], undefined, [], undefined, undefined, prep);
    await (loop as unknown as { runStep(t: unknown): Promise<unknown> }).runStep(await h.reloadTicket(t.id));
    expect(stageRan).toBe(false);
    expect(await h.reloadTicket(t.id)).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help' });
    // Resumed with the commits dealt with by hand, the preparation completes and the stage runs.
    sh(ws, 'reset', '-q', '--hard', 'HEAD~1');
    await states.resume(t.id, 'user', 'dealt with');
    await (loop as unknown as { runStep(t: unknown): Promise<unknown> }).runStep(await h.reloadTicket(t.id));
    expect(stageRan).toBe(true);
    expect((await h.reloadTicket(t.id)).revertFromSha).toBeNull();
  });
});
