import { staticCredentials } from '../../testing/static-credentials';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import type { StageRequest, StageResult } from '../agent-runner/agent-runner';
import { ContainerRunner } from '../agent-runner/container-runner';
import { FakeEngine } from '../agent-runner/fake-engine';
import { GitRunner } from '../git/git-runner';
import { MirrorService } from '../git/mirror.service';
import { WorkspaceService } from '../git/workspace.service';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { KbBuildService } from './kb-build.service';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('kbBuild stage (F6)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let projectId: string;
  let workspaces: WorkspaceService;
  let service: KbBuildService;
  let n = 0;
  let lastRequest: StageRequest | null = null;
  /** What the "model" does in the workspace, and what it answers. */
  let script: (ws: string) => void;
  let answer: StageEnvelope;
  let failWith: StageResult | null = null;

  const ticket = async () => {
    const t = await prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, source: 'paste', title: 'Export bookings to CSV', status: 'KB' } });
    await workspaces.prepare(t.id);
    return t;
  };
  const wsOf = (t: Ticket) => path.join(tmp, 'data', 'workspaces', projectId, t.key);
  const newDoc = (key = 'billing-export'): StageEnvelope => ({ status: 'done', summary: 'doc written', data: { featureKey: key, isNew: true, docPath: `docs/kb/${key}.md`, globs: ['src/billing/**'] } as never });
  const write = (ws: string, rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-kbb-'));
    const source = path.join(tmp, 'source');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    mkdirSync(path.join(source, 'docs/kb'), { recursive: true });
    mkdirSync(path.join(source, 'src'));
    writeFileSync(path.join(source, 'package.json'), '{}');
    writeFileSync(path.join(source, 'src/app.ts'), 'original');
    writeFileSync(path.join(source, 'docs/kb/features.json'), JSON.stringify({ version: 1, features: [{ key: 'bookings', title: 'Bookings', doc: 'bookings.md' }] }));
    writeFileSync(path.join(source, 'docs/kb/bookings.md'), '# Bookings\noriginal doc');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'init');
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url, TEST_PUSH_URL_PREFIXES: 'file://', GIT_AUTHOR_NAME: 'Dev Bot', GIT_AUTHOR_EMAIL: 'bot@example.com' } as NodeJS.ProcessEnv);
    const project = await prisma.project.create({ data: { name: 'p', repoUrl: `file://${source}`, baseBranch: 'dev', stack: 'ts_node', installCmd: '', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'pending' } });
    projectId = project.id;
    await new MirrorService(prisma, config, staticCredentials()).clone(project);
    const git = new GitRunner({ token: async () => '' });
    workspaces = new WorkspaceService(prisma, config, git, new VerifyService(new ContainerRunner(new FakeEngine()), config), staticCredentials());
    // A stand-in for AgentRunner: it plays the model's side, then applies the same validate hook the real one does.
    const runner = {
      async run(req: StageRequest): Promise<StageResult> {
        lastRequest = req;
        if (failWith) return failWith;
        script(req.workspacePath as string);
        const message = req.validate?.(answer);
        if (message) return { kind: 'failed', reason: `Validation failed: ${message}`, stageRunId: 'run-x', attempts: 2 };
        return { kind: 'done', envelope: answer, stageRunId: 'run-x', attempts: 1 };
      },
    };
    const launcher = new StageLauncher(prisma, config, runner as never);
    service = new KbBuildService(prisma, launcher, new StageOutcomes(prisma), workspaces, git);
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    failWith = null;
    lastRequest = null;
    await prisma.event.deleteMany();
    await prisma.project.update({ where: { id: projectId }, data: { settings: { stages: { featureMap: { enabled: false } } } as never } });
  });

  it('builds a new doc: updates the index, commits it on the ticket branch, and moves to PLANNING', async () => {
    const t = await ticket();
    const ws = wsOf(t);
    script = (w) => write(w, 'docs/kb/billing-export.md', '# Billing export\n\n## Overview\nExports bookings.\n');
    answer = newDoc();
    const out = await service.run(t);
    expect(out).toMatchObject({ kind: 'transition', to: 'PLANNING', reason: 'KB doc built: billing-export', stageRunId: 'run-x' });

    expect(sh(ws, 'log', '-1', '--format=%s')).toBe(`docs(${t.key}): add billing-export knowledge base doc`);
    expect(sh(ws, 'log', '-1', '--format=%an <%ae>')).toBe('Dev Bot <bot@example.com>');
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['docs/kb/billing-export.md', 'docs/kb/features.json']);
    const index = JSON.parse(readFileSync(path.join(ws, 'docs/kb/features.json'), 'utf8'));
    expect(index.features.map((f: { key: string }) => f.key)).toEqual(['billing-export', 'bookings']);
    expect(index.features[0]).toMatchObject({ key: 'billing-export', title: 'Billing Export', doc: 'billing-export.md', globs: ['src/billing/**'] });
    expect(index.features[0].builtFromCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(ws, 'status', '--porcelain')).toBe('');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).featureKey).toBe('billing-export');
  });

  it('gives the stage the index keys, the KB directory and the line limit, with a writable workspace', async () => {
    script = (w) => write(w, 'docs/kb/billing-export.md', 'doc');
    answer = newDoc();
    await service.run(await ticket());
    expect(lastRequest).toMatchObject({ stage: 'kbBuild', modelAlias: 'sonnet', maxTurns: 30, stack: 'ts_node', inputs: { indexKeys: ['bookings'], kbDir: 'docs/kb', kbDocMaxLines: 300 } });
  });

  it('reverts changes outside the KB directory, logs a warning, and still commits the doc', async () => {
    const t = await ticket();
    const ws = wsOf(t);
    script = (w) => {
      write(w, 'docs/kb/billing-export.md', 'doc');
      write(w, 'src/app.ts', 'TAMPERED');
      write(w, 'src/extra.ts', 'oops');
    };
    answer = newDoc();
    await service.run(t);
    expect(readFileSync(path.join(ws, 'src/app.ts'), 'utf8')).toBe('original');
    expect(existsSync(path.join(ws, 'src/extra.ts'))).toBe(false);
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('src/');
    const warning = (await prisma.event.findMany({ where: { ticketId: t.id, type: 'git' } })).find((e) => e.message.includes('outside docs/kb'));
    expect(warning?.message).toContain('src/app.ts');
    expect(warning?.message).toContain('src/extra.ts');
  });

  it('selects an existing doc without writing or committing anything', async () => {
    const t = await ticket();
    const ws = wsOf(t);
    const head = sh(ws, 'rev-parse', 'HEAD');
    script = (w) => write(w, 'docs/kb/bookings.md', 'REWRITTEN BY THE MODEL');
    answer = { status: 'done', summary: 'existing', data: { featureKey: 'bookings', isNew: false, docPath: 'docs/kb/bookings.md', globs: [] } as never };
    const out = await service.run(t);
    expect(out).toMatchObject({ kind: 'transition', to: 'PLANNING', reason: 'KB doc selected: bookings' });
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(ws, 'docs/kb/bookings.md'), 'utf8')).toBe('# Bookings\noriginal doc');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).featureKey).toBe('bookings');
  });

  describe('orchestrator validation fails the attempt', () => {
    const run = async () => (await service.run(await ticket())) as { kind: string; reason?: string; note?: string };

    it('isNew=false with a key that is not in the index', async () => {
      script = () => undefined;
      answer = { status: 'done', summary: 's', data: { featureKey: 'ghost', isNew: false, docPath: 'docs/kb/ghost.md', globs: [] } as never };
      const out = await run();
      expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect(out.note).toContain('"ghost" is not in the KB index');
    });

    it('isNew=true with a key that already exists', async () => {
      script = (w) => write(w, 'docs/kb/bookings.md', 'dup');
      answer = newDoc('bookings');
      expect((await run()).note).toContain('already exists in the KB index');
    });

    it('a doc path outside the KB directory, or not markdown', async () => {
      script = (w) => write(w, 'src/billing-export.md', 'doc');
      answer = { status: 'done', summary: 's', data: { featureKey: 'billing-export', isNew: true, docPath: 'src/billing-export.md', globs: [] } as never };
      expect((await run()).note).toContain('must be a .md file inside docs/kb');
      answer = { status: 'done', summary: 's', data: { featureKey: 'billing-export', isNew: true, docPath: 'docs/kb/../../etc/x.md', globs: [] } as never };
      expect((await run()).note).toContain('must be a .md file inside docs/kb');
    });

    it('a doc that was not written, an over-long doc, and an invalid key', async () => {
      script = () => undefined;
      answer = newDoc();
      expect((await run()).note).toContain('was not written');
      await prisma.project.update({ where: { id: projectId }, data: { settings: { stages: { featureMap: { enabled: false } }, limits: { kbDocMaxLines: 50 } } as never } });
      script = (w) => write(w, 'docs/kb/billing-export.md', Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'));
      expect((await run()).note).toContain('more than the limit of 50');
      answer = newDoc('Bad Key!');
      expect((await run()).note).toContain('not a valid key');
    });
  });

  it('turns a failed, killed or question-asking stage into the documented hold', async () => {
    script = () => undefined;
    const t = await ticket();
    const asked = await prisma.stageRun.create({ data: { projectId, ticketId: t.id, stage: 'kbBuild', model: 'sonnet', status: 'needs_input' } });
    failWith = { kind: 'needs_input', question: 'Which feature is this?', stageRunId: asked.id, attempts: 1 };
    expect(await service.run(t)).toMatchObject({ kind: 'hold', reason: 'awaiting_answer' });
    expect(await prisma.supportTicket.count({ where: { ticketId: t.id } })).toBe(1);
    failWith = { kind: 'killed', stageRunId: 'run-k', attempts: 1 };
    expect(await service.run(await ticket())).toMatchObject({ kind: 'hold', reason: 'manual' });
  });
});
