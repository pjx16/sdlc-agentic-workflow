import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Docker from 'dockerode';
import type { StageEnvelope, StageName } from '@sdlc/shared';
import type { Subtask, Ticket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { StageRequest, StageResult } from '../worker/agent-runner/agent-runner';
import type { ContainerEngine, ContainerHandle } from '../worker/agent-runner/container-engine';
import { ContainerRunner } from '../worker/agent-runner/container-runner';
import { FakeHandle } from '../worker/agent-runner/fake-engine';
import { GitRunner } from '../worker/git/git-runner';
import { MirrorService } from '../worker/git/mirror.service';
import { WorkspaceService } from '../worker/git/workspace.service';
import { StageLauncher } from '../worker/pipeline/stage-launcher';
import { StageOutcomes } from '../worker/pipeline/stage-outcomes';
import { VerifyService } from '../worker/verify/verify.service';
import { WorkerConfig } from '../worker/worker-config';
import { type TestDatabase, createTestDatabase } from './test-db';

export const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

export interface CmdRule {
  match: RegExp;
  exitCode: number;
  lines?: string[];
}

/** A container engine that answers `run-cmd` containers from rules keyed on the command, and records every command. */
export class ScriptedEngine implements ContainerEngine {
  rules: CmdRule[] = [];
  commands: string[] = [];
  /** What an unmatched command does. */
  defaultResult: { exitCode: number; lines: string[] } = { exitCode: 0, lines: ['ok'] };

  async create(options: Docker.ContainerCreateOptions): Promise<ContainerHandle> {
    const cmd = (options.Env ?? []).find((e) => e.startsWith('CMD='))?.slice(4) ?? '';
    this.commands.push(cmd);
    const rule = this.rules.find((r) => r.match.test(cmd));
    return new FakeHandle(`scripted-${this.commands.length}`, rule ? { exitCode: rule.exitCode, lines: rule.lines ?? [] } : { exitCode: this.defaultResult.exitCode, lines: this.defaultResult.lines });
  }
  async removeByLabel(): Promise<number> {
    return 0;
  }
  /** Commands that ran, for assertions. */
  ran(pattern: RegExp): string[] {
    return this.commands.filter((c) => pattern.test(c));
  }
  reset(): void {
    this.rules = [];
    this.commands = [];
    this.defaultResult = { exitCode: 0, lines: ['ok'] };
  }
}

export type StageScript = (ctx: { ws: string; req: StageRequest; attempt: number }) => StageEnvelope | Promise<StageEnvelope>;

/**
 * Stands in for AgentRunner in tests: runs a script per stage (which may edit the workspace), records real StageRun rows like the
 * runner does, applies the orchestrator's `validate` hook, and retries once on a rejected output (BUILD_PLAN 6.8).
 */
export class StubAgent {
  scripts: Partial<Record<StageName, StageScript>> = {};
  requests: StageRequest[] = [];
  /** A result to return instead of running a script (for kill, needs_input, ...). */
  override: StageResult | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async run(req: StageRequest): Promise<StageResult> {
    this.requests.push(req);
    if (this.override) return this.override;
    const script = this.scripts[req.stage];
    if (!script) throw new Error(`No stage script for ${req.stage}`);
    let reason = 'unknown';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const run = await this.prisma.stageRun.create({
        data: { projectId: req.projectId, ticketId: req.ticketId ?? null, subtaskId: req.subtaskId ?? null, stage: req.stage, model: req.modelAliases[req.modelAlias], attempt, round: req.round ?? 0, reason: req.reason ?? null, status: 'running', startedAt: new Date() },
      });
      const envelope = await script({ ws: req.workspacePath as string, req, attempt });
      const message = req.validate?.(envelope) ?? null;
      const ok = envelope.status === 'done' && !message;
      await this.prisma.stageRun.update({ where: { id: run.id }, data: { status: ok ? 'succeeded' : 'failed', endedAt: new Date(), error: ok ? null : (message ?? `status ${envelope.status}`) } });
      if (ok) return { kind: 'done', envelope, stageRunId: run.id, attempts: attempt };
      reason = message ? `Validation failed: ${message}` : `The stage reported ${envelope.status}`;
    }
    return { kind: 'failed', reason, stageRunId: 'failed-run', attempts: 2 };
  }
}

/** The pieces step tests need: a real Postgres database, a real git repository and workspace, scripted containers, a stub agent. */
export class StepsHarness {
  readonly engine = new ScriptedEngine();
  agent!: StubAgent;
  prisma!: PrismaService;
  db!: TestDatabase;
  tmp!: string;
  source!: string;
  bare!: string;
  projectId!: string;
  config!: WorkerConfig;
  git = new GitRunner({ githubToken: '' });
  workspaces!: WorkspaceService;
  verify!: VerifyService;
  launcher!: StageLauncher;
  outcomes!: StageOutcomes;
  private n = 0;

  static async create(opts: { project?: Record<string, unknown> } = {}): Promise<StepsHarness> {
    const h = new StepsHarness();
    h.db = await createTestDatabase();
    process.env.DATABASE_URL = h.db.url;
    h.prisma = new PrismaService();
    await h.prisma.onModuleInit();
    h.tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-steps-'));

    // The "remote": a bare repository seeded from a small project with one existing test.
    h.source = path.join(h.tmp, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'dev', h.source]);
    mkdirSync(path.join(h.source, 'src'), { recursive: true });
    mkdirSync(path.join(h.source, 'docs/kb'), { recursive: true });
    writeFileSync(path.join(h.source, 'package.json'), '{"name":"target","version":"1.0.0"}\n');
    writeFileSync(path.join(h.source, 'src/app.ts'), 'export const app = 1;\n');
    writeFileSync(path.join(h.source, 'src/app.test.ts'), "import { app } from './app';\n// existing test\n");
    sh(h.source, 'add', '.');
    sh(h.source, 'commit', '-q', '-m', 'init');
    h.bare = path.join(h.tmp, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', h.source, h.bare]);

    h.config = new WorkerConfig({ DATA_DIR: path.join(h.tmp, 'data'), DATABASE_URL: h.db.url, GIT_AUTHOR_NAME: 'Dev Bot', GIT_AUTHOR_EMAIL: 'bot@example.com', GUIDELINES_DIR: path.join(h.tmp, 'guidelines') } as NodeJS.ProcessEnv);
    const project = await h.prisma.project.create({
      data: {
        name: 'target', repoUrl: `file://${h.bare}`, baseBranch: 'dev', stack: 'ts_node', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx vitest run {files}',
        localKeyPrefix: 'TGT', mirrorStatus: 'pending', ...(opts.project ?? {}),
      },
    });
    h.projectId = project.id;
    await new MirrorService(h.prisma, h.config).clone(project);

    h.verify = new VerifyService(new ContainerRunner(h.engine), h.config);
    h.workspaces = new WorkspaceService(h.prisma, h.config, h.git, h.verify);
    h.agent = new StubAgent(h.prisma);
    h.launcher = new StageLauncher(h.prisma, h.config, h.agent as never);
    h.outcomes = new StageOutcomes(h.prisma);
    return h;
  }

  async close(): Promise<void> {
    await this.prisma?.onModuleDestroy();
    await this.db?.drop();
    rmSync(this.tmp, { recursive: true, force: true });
  }

  setProject(data: Record<string, unknown>) {
    return this.prisma.project.update({ where: { id: this.projectId }, data: data as never });
  }

  /** A ticket IN_PROGRESS with a prepared workspace on its branch. */
  async ticket(over: Record<string, unknown> = {}): Promise<Ticket> {
    const t = await this.prisma.ticket.create({ data: { projectId: this.projectId, key: `TGT-${++this.n}`, source: 'paste', title: 'Export bookings', body: 'Add a CSV export.', status: 'IN_PROGRESS', planMarkdown: '# Plan', ...over } });
    await this.workspaces.prepare(t.id);
    return t;
  }

  subtask(ticketId: string, seq: number, over: Record<string, unknown> = {}): Promise<Subtask> {
    return this.prisma.subtask.create({ data: { ticketId, seq, title: `Subtask ${seq}`, description: `Do ${seq}`, acceptanceCriteria: [`criterion ${seq}`], files: [`src/f${seq}.ts`], dependsOn: [], ...over } as never });
  }

  ws(t: Pick<Ticket, 'key'>): string {
    return this.config.workspacePath(this.projectId, t.key);
  }

  write(ws: string, rel: string, content: string): void {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  }

  reload = (id: string) => this.prisma.subtask.findUniqueOrThrow({ where: { id } });
  reloadTicket = (id: string) => this.prisma.ticket.findUniqueOrThrow({ where: { id } });
}
