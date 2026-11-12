import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { ContainerRunner } from '../agent-runner/container-runner';
import { FakeEngine } from '../agent-runner/fake-engine';
import { GitRunner } from '../git/git-runner';
import { MirrorService } from '../git/mirror.service';
import { WorkspaceService } from '../git/workspace.service';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { KbHandler } from './kb.handler';
import { NewTicketHandler } from './new-ticket.handler';
import { StageOutcomes } from './stage-outcomes';
import type { StepOutcome } from './step-handler';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('NEW and KB step handlers', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let source: string;
  let projectId: string;
  let workspaces: WorkspaceService;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, source: 'paste', title: 'Add export', status: 'NEW', ...over } });
  const setSettings = (settings: object) => prisma.project.update({ where: { id: projectId }, data: { settings: settings as never } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-kbh-'));
    source = path.join(tmp, 'source');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    mkdirSync(path.join(source, 'docs/kb'), { recursive: true });
    writeFileSync(path.join(source, 'package.json'), '{}');
    writeFileSync(path.join(source, 'docs/kb/features.json'), JSON.stringify({ version: 1, features: [{ key: 'bookings', title: 'Bookings', doc: 'bookings.md' }] }));
    writeFileSync(path.join(source, 'docs/kb/bookings.md'), '# Bookings');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'init');
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    const project = await prisma.project.create({ data: { name: 'p', repoUrl: `file://${source}`, baseBranch: 'dev', stack: 'ts_node', installCmd: 'npm ci', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'pending' } });
    projectId = project.id;
    await new MirrorService(prisma, config).clone(project);
    workspaces = new WorkspaceService(prisma, config, new GitRunner({ githubToken: '' }), new VerifyService(new ContainerRunner(new FakeEngine({ lines: ['ok'] })), config));
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await prisma.event.deleteMany();
    await setSettings({});
  });

  describe('NewTicketHandler (NEW -> KB)', () => {
    it('prepares the workspace and moves to KB', async () => {
      const t = await ticket();
      const out = await new NewTicketHandler(workspaces).run(t);
      expect(out).toMatchObject({ kind: 'transition', to: 'KB' });
      expect((out as { reason: string }).reason).toContain('feature/ABC-');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).branch).toMatch(/^feature\/ABC-\d+-add-export$/);
    });

    it('holds the ticket (needs_help) when the dependency install fails', async () => {
      const failing = new WorkspaceService(prisma, new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv), new GitRunner({ githubToken: '' }), new VerifyService(new ContainerRunner(new FakeEngine({ exitCode: 1, lines: ['npm ERR! 404'] })), new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv)));
      const out = (await new NewTicketHandler(failing).run(await ticket())) as Extract<StepOutcome, { kind: 'hold' }>;
      expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect(out.note).toContain('install failed');
      expect(out.note).toContain('npm ERR! 404');
    });
  });

  describe('KbHandler (KB -> PLANNING)', () => {
    const handler = (builder?: { run(t: Ticket): Promise<StepOutcome> }) => new KbHandler(prisma, workspaces, builder);

    it('uses a matching KB doc, via the feature key field', async () => {
      const t = await ticket({ status: 'KB', featureKey: 'bookings' });
      const out = await handler().run(t);
      expect(out).toMatchObject({ kind: 'transition', to: 'PLANNING', reason: 'KB doc matched: bookings' });
    });

    it('matches a Jira label feature:<key> and records the key on the ticket', async () => {
      const t = await ticket({ status: 'KB', source: 'jira', externalKey: `ABC-L${n}`, labels: ['backend', 'feature:bookings'] });
      expect(await handler().run(t)).toMatchObject({ kind: 'transition', to: 'PLANNING' });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).featureKey).toBe('bookings');
    });

    it('with no match, runs kbBuild when it is on', async () => {
      const t = await ticket({ status: 'KB', featureKey: 'unknown' });
      let called = 0;
      const out = await handler({ run: async () => (called++, { kind: 'transition', to: 'PLANNING', reason: 'built' }) }).run(t);
      expect(called).toBe(1);
      expect(out).toMatchObject({ kind: 'transition', reason: 'built' });
    });

    it('with no match and kbBuild off, goes straight to planning without a KB doc', async () => {
      await setSettings({ stages: { kbBuild: { enabled: false } } });
      let called = 0;
      const out = await handler({ run: async () => (called++, { kind: 'stay' }) }).run(await ticket({ status: 'KB' }));
      expect(called).toBe(0);
      expect(out).toMatchObject({ kind: 'transition', to: 'PLANNING', reason: 'No KB doc, and kbBuild is off' });
    });

    it('holds if kbBuild is needed but not available', async () => {
      expect(await handler().run(await ticket({ status: 'KB' }))).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    });

    it('handles a corrupt index as empty and records a warning', async () => {
      const ws = path.join(tmp, 'data', 'workspaces', projectId);
      const t = await ticket({ status: 'KB' });
      await workspaces.prepare(t.id);
      writeFileSync(path.join(ws, t.key, 'docs/kb/features.json'), '{ nope');
      await setSettings({ stages: { kbBuild: { enabled: false } } });
      expect(await handler().run(t)).toMatchObject({ kind: 'transition', to: 'PLANNING' });
      expect((await prisma.event.findMany({ where: { ticketId: t.id, type: 'git' } })).some((e) => e.message.includes('not a valid KB index'))).toBe(true);
    });
  });

  describe('StageOutcomes (BUILD_PLAN 6.8)', () => {
    const outcomes = () => new StageOutcomes(prisma);
    it('turns each non-success result into the documented outcome', async () => {
      const t = await ticket();
      const run = await prisma.stageRun.create({ data: { projectId, ticketId: t.id, stage: 'plan', model: 'opus', status: 'failed' } });
      const o = outcomes();
      expect(await o.forResult(t.id, 'plan', { kind: 'failed', reason: 'bad output', stageRunId: run.id, attempts: 2 })).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect(await o.forResult(t.id, 'plan', { kind: 'turn_limit', stageRunId: run.id, attempts: 1 })).toMatchObject({ kind: 'hold', reason: 'needs_help', note: 'The plan stage reached its turn limit' });
      expect(await o.forResult(t.id, 'plan', { kind: 'killed', stageRunId: run.id, attempts: 1 })).toMatchObject({ kind: 'hold', reason: 'manual' });
      expect(await o.forResult(t.id, 'plan', { kind: 'needs_input', question: 'Which db?', stageRunId: run.id, attempts: 1 })).toMatchObject({ kind: 'hold', reason: 'awaiting_answer' });
      expect((await prisma.supportQuery.findMany({ where: { ticketId: t.id } }))[0]).toMatchObject({ question: 'Which db?', status: 'open', stage: 'plan' });
    });

    it('pauses the pipeline on a rate limit and leaves the ticket where it is', async () => {
      const t = await ticket();
      const resetsAt = new Date('2026-12-01T00:00:00Z');
      expect(await outcomes().forResult(t.id, 'plan', { kind: 'rate_limited', resetsAt, stageRunId: 'x', attempts: 1 })).toEqual({ kind: 'stay' });
      expect(await prisma.globalSettings.findUniqueOrThrow({ where: { id: 'global' } })).toMatchObject({ pipelinePaused: true, pausedReason: 'rate_limit', resetsAt });
    });
  });
});
