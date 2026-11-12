import { staticCredentials } from '../../testing/static-credentials';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { HumanReviewHandler, KbUpdateHandler } from './kb-update.handler';
import { KbUpdateService } from './kb-update.service';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('kbUpdate stage (F11)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let projectId: string;
  let workspaces: WorkspaceService;
  let service: KbUpdateService;
  let handler: KbUpdateHandler;
  let humanReview: HumanReviewHandler;
  let n = 0;
  let lastRequest: StageRequest | null = null;
  let script: (ws: string) => void;
  let answer: StageEnvelope;
  let calls = 0;

  const write = (ws: string, rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  };
  const wsOf = (t: Ticket) => path.join(tmp, 'data', 'workspaces', projectId, t.key);
  /** A ticket on its branch with one code commit past the base branch. */
  const ticket = async (featureKey: string | null = 'bookings', status: Ticket['status'] = 'KB_UPDATE') => {
    const t = await prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, source: 'paste', title: 'Export bookings', status, featureKey } });
    await workspaces.prepare(t.id);
    write(wsOf(t), 'src/app.ts', 'changed');
    await workspaces.commit(t.id, `feat(${t.key}): change app`);
    return prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
  };
  const answerFor = (changed = true, featureKey = 'bookings'): StageEnvelope => ({ status: 'done', summary: 'ok', data: { featureKey, docPath: 'docs/kb/bookings.md', changed } as never });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-kbu-'));
    const source = path.join(tmp, 'source');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    mkdirSync(path.join(source, 'docs/kb'), { recursive: true });
    mkdirSync(path.join(source, 'src'));
    writeFileSync(path.join(source, 'package.json'), '{}');
    writeFileSync(path.join(source, 'src/app.ts'), 'original');
    writeFileSync(path.join(source, 'docs/kb/features.json'), JSON.stringify({ version: 1, features: [{ key: 'bookings', title: 'Bookings', doc: 'bookings.md', builtFromCommit: 'old', updatedAt: '2020-01-01T00:00:00.000Z' }] }));
    writeFileSync(path.join(source, 'docs/kb/bookings.md'), '# Bookings\noriginal doc\n');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'init');
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url, TEST_PUSH_URL_PREFIXES: 'file://', GIT_AUTHOR_NAME: 'Dev Bot', GIT_AUTHOR_EMAIL: 'bot@example.com', GUIDELINES_DIR: path.resolve(__dirname, '../../../../../guidelines') } as NodeJS.ProcessEnv);
    const project = await prisma.project.create({ data: { name: 'p', repoUrl: `file://${source}`, baseBranch: 'dev', stack: 'ts_node', installCmd: '', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'pending' } });
    projectId = project.id;
    await new MirrorService(prisma, config, staticCredentials()).clone(project);
    const git = new GitRunner({ token: async () => '' });
    workspaces = new WorkspaceService(prisma, config, git, new VerifyService(new ContainerRunner(new FakeEngine()), config), staticCredentials());
    const runner = {
      async run(req: StageRequest): Promise<StageResult> {
        lastRequest = req;
        calls++;
        script(req.workspacePath as string);
        const message = req.validate?.(answer);
        if (message) return { kind: 'failed', reason: `Validation failed: ${message}`, stageRunId: 'run-x', attempts: 2 };
        return { kind: 'done', envelope: answer, stageRunId: 'run-x', attempts: 1 };
      },
    };
    const launcher = new StageLauncher(prisma, config, runner as never);
    service = new KbUpdateService(prisma, launcher, new StageOutcomes(prisma), workspaces, git, config);
    handler = new KbUpdateHandler(service);
    humanReview = new HumanReviewHandler(prisma, service);
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    lastRequest = null;
    calls = 0;
  });

  it('updates the doc, refreshes the index entry, commits only kbDir, pushes, and moves to AWAITING_CI', async () => {
    const t = await ticket();
    const ws = wsOf(t);
    script = (w) => write(w, 'docs/kb/bookings.md', '# Bookings\nupdated doc\n');
    answer = answerFor();
    const out = await handler.run(t);
    expect(out).toMatchObject({ kind: 'transition', to: 'AWAITING_CI' });
    expect(sh(ws, 'log', '-1', '--format=%s')).toBe(`docs(${t.key}): update bookings knowledge base`);
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['docs/kb/bookings.md', 'docs/kb/features.json']);
    const entry = JSON.parse(readFileSync(path.join(ws, 'docs/kb/features.json'), 'utf8')).features[0];
    expect(entry.builtFromCommit).toBe(sh(ws, 'rev-parse', 'HEAD~1'));
    expect(entry.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(sh(ws, 'status', '--porcelain')).toBe('');
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(sh(path.join(tmp, 'source'), 'rev-parse', t.branch as string));
    expect(lastRequest).toMatchObject({ stage: 'kbUpdate', inputs: { kbDir: 'docs/kb', kbDocMaxLines: 300, existingDoc: '# Bookings\noriginal doc\n' } });
    expect((lastRequest?.inputs as { diff: string }).diff).toContain('src/app.ts');
    expect((lastRequest?.inputs as { docTemplate: string }).docTemplate).toContain('Knowledge-base doc template');
  });

  it('makes no commit when the change does not affect the doc', async () => {
    const t = await ticket();
    const ws = wsOf(t);
    const before = sh(ws, 'rev-parse', 'HEAD');
    script = () => undefined;
    answer = answerFor(false);
    expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'AWAITING_CI' });
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('reverts changes outside kbDir and the index file, and does not commit them', async () => {
    const t = await ticket();
    const ws = wsOf(t);
    script = (w) => {
      write(w, 'docs/kb/bookings.md', '# Bookings\nnew\n');
      write(w, 'src/app.ts', 'TAMPERED');
    };
    answer = answerFor();
    await handler.run(t);
    expect(readFileSync(path.join(ws, 'src/app.ts'), 'utf8')).toBe('changed');
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('src/');
  });

  it('skips a ticket with no KB doc without running the stage', async () => {
    const t = await ticket(null);
    script = () => undefined;
    answer = answerFor();
    expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'AWAITING_CI', reason: expect.stringContaining('no KB doc') });
    expect(calls).toBe(0);
  });

  it('fails the attempt when the doc is over the line limit or the featureKey changes', async () => {
    const t = await ticket();
    script = (w) => write(w, 'docs/kb/bookings.md', `${'line\n'.repeat(400)}`);
    answer = answerFor();
    const out = await handler.run(t);
    expect(out.kind).not.toBe('transition');
    script = () => undefined;
    answer = answerFor(true, 'other');
    expect((await handler.run(t)).kind).not.toBe('transition');
  });

  it('the re-run in IN_HUMAN_REVIEW runs once, clears the flag, and keeps the status', async () => {
    const t = await ticket('bookings', 'IN_HUMAN_REVIEW');
    expect(await humanReview.run(t)).toEqual({ kind: 'stay' });
    expect(calls).toBe(0);
    await prisma.ticket.update({ where: { id: t.id }, data: { kbUpdatePending: true } });
    script = (w) => write(w, 'docs/kb/bookings.md', '# Bookings\nrerun\n');
    answer = answerFor();
    const out = await humanReview.run(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } }));
    expect(out).toEqual({ kind: 'continue' });
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(after).toMatchObject({ kbUpdatePending: false, status: 'IN_HUMAN_REVIEW' });
    expect(sh(wsOf(t), 'log', '-1', '--format=%s')).toBe(`docs(${t.key}): update bookings knowledge base`);
  });
});
