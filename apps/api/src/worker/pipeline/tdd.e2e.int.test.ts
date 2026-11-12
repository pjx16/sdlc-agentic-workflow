import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeGitHub } from '../../testing/fake-github';
import { docker, leftoverAgentContainers, startEgress, type EgressFixture } from '../../testing/docker-fixture';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { AgentRunner } from '../agent-runner/agent-runner';
import { DockerodeEngine } from '../agent-runner/container-engine';
import { ContainerRunner } from '../agent-runner/container-runner';
import { FileLogSink } from '../agent-runner/file-log-sink';
import { PrismaStageRunStore } from '../agent-runner/stage-run-store';
import { GitRunner } from '../git/git-runner';
import { MirrorService } from '../git/mirror.service';
import { WorkspaceService } from '../git/workspace.service';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { InProgressHandler } from './in-progress.handler';
import { PrService } from './pr.service';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepOutcome } from './step-handler';
import { SubtaskStepsService } from './subtask-steps.service';

const ROOT = path.resolve(__dirname, '../../../../..');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** The test command of the target repository: a test "fails" while its implementation is missing or marked NOT_IMPLEMENTED. */
const CHECK_SH = `#!/bin/sh
status=0
for f in "$@"; do
  n=$(echo "$f" | sed -n 's#.*f\\([0-9]*\\)\\.test\\.ts#\\1#p')
  if grep -q BROKEN_IMPORT "$f"; then echo "Error: Cannot find module './broken'"; status=1; continue; fi
  if grep -q ALWAYS_PASS "$f"; then echo "PASS $f (always)"; continue; fi
  impl="src/f$n.ts"
  if [ ! -f "$impl" ] || grep -q NOT_IMPLEMENTED "$impl"; then echo "FAIL $f: f$n is not implemented"; status=1; else echo "PASS $f"; fi
done
exit $status
`;

/**
 * Milestone 7, "done when": with fake-claude scenarios, a two-subtask ticket produces four commits in order, a failing
 * implementation triggers fix rounds and then needs_help, tampering with a test file is undone, and a draft PR is opened after the
 * first subtask. Real containers (run-cmd and the agent), real git and a local bare remote; only the model and GitHub are mocked.
 */
describe('subtask TDD loop end to end (real containers, fake-claude)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let egress: EgressFixture;
  let tmp: string;
  let bare: string;
  let source: string;
  let n = 0;

  interface Rig {
    steps: SubtaskStepsService;
    handler: InProgressHandler;
    workspaces: WorkspaceService;
    github: FakeGitHub;
    config: WorkerConfig;
    ticketId: string;
    key: string;
    ws: string;
    projectId: string;
    subtaskIds: string[];
  }

  /** A project, mirror, ticket and two PENDING subtasks, wired to the given fake-claude scenario. */
  async function rig(scenario: string, opts: { project?: Record<string, unknown>; subtasks?: number } = {}): Promise<Rig> {
    const dataDir = path.join(tmp, `data-${++n}`);
    mkdirSync(dataDir, { recursive: true });
    chmodSync(dataDir, 0o777);
    const config = new WorkerConfig({
      DATA_DIR: dataDir, DATABASE_URL: db.url, CLAUDE_CODE_OAUTH_TOKEN: 'fake-token', GUIDELINES_DIR: path.join(ROOT, 'guidelines'), GIT_AUTHOR_NAME: 'Dev Bot', GIT_AUTHOR_EMAIL: 'bot@example.com',
      AGENT_EXTRA_BINDS: `${ROOT}/test/fake-claude/claude:/usr/local/bin/claude:ro,${ROOT}/test/fake-claude:/fake-claude:ro`,
      AGENT_EXTRA_ENV: `FAKE_SCENARIO=${scenario},FAKE_SCENARIOS_DIR=/fake-claude/scenarios`,
    } as NodeJS.ProcessEnv);
    const project = await prisma.project.create({
      data: { name: `proj-${n}`, repoUrl: `file://${bare}`, baseBranch: 'dev', stack: 'ts_node', installCmd: 'echo installed', typecheckCmd: 'echo typecheck ok', testCmdTemplate: 'sh check.sh {files}', localKeyPrefix: 'TGT', mirrorStatus: 'pending', ...(opts.project ?? {}) },
    });
    await new MirrorService(prisma, config).clone(project);
    const containers = new ContainerRunner(new DockerodeEngine(docker));
    const git = new GitRunner({ githubToken: '' });
    const verify = new VerifyService(containers, config);
    const workspaces = new WorkspaceService(prisma, config, git, verify);
    const agent = new AgentRunner(containers, config, new PrismaStageRunStore(prisma), new FileLogSink(config));
    const launcher = new StageLauncher(prisma, config, agent);
    const outcomes = new StageOutcomes(prisma);
    const github = new FakeGitHub();
    const steps = new SubtaskStepsService(prisma, launcher, outcomes, workspaces, git, verify, config, new PrService(prisma, config, github));

    const ticket = await prisma.ticket.create({ data: { projectId: project.id, key: `TGT-${n}`, source: 'paste', title: 'Export bookings', body: 'Add a CSV export.', status: 'IN_PROGRESS', planMarkdown: '# Plan' } });
    await workspaces.prepare(ticket.id);
    const subtaskIds: string[] = [];
    const titles = ['Add the export service', 'Add the export endpoint'];
    for (let seq = 1; seq <= (opts.subtasks ?? 2); seq++) {
      subtaskIds.push((await prisma.subtask.create({ data: { ticketId: ticket.id, seq, title: titles[seq - 1] as string, description: `Do ${seq}`, acceptanceCriteria: [`criterion ${seq}`], files: [`src/f${seq}.ts`], dependsOn: seq > 1 ? [seq - 1] : [] } })).id);
    }
    return { steps, handler: new InProgressHandler(prisma, steps), workspaces, github, config, ticketId: ticket.id, key: ticket.key, ws: config.workspacePath(project.id, ticket.key), projectId: project.id, subtaskIds };
  }

  const drive = async (r: Rig, until?: () => Promise<boolean>): Promise<StepOutcome[]> => {
    const outcomes: StepOutcome[] = [];
    for (let i = 0; i < 80; i++) {
      const out = await r.handler.run(await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } }));
      outcomes.push(out);
      if (out.kind !== 'continue' || (until && (await until()))) break;
    }
    return outcomes;
  };
  const subtask = (id: string) => prisma.subtask.findUniqueOrThrow({ where: { id } });
  const log = (r: Rig) => sh(r.ws, 'log', '--reverse', '--format=%s', 'dev..HEAD').split('\n').filter(Boolean);

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-tdd-')));
    chmodSync(tmp, 0o777);
    source = path.join(tmp, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    mkdirSync(path.join(source, 'src'), { recursive: true });
    writeFileSync(path.join(source, 'package.json'), '{"name":"target","version":"1.0.0"}\n');
    writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(source, 'check.sh'), CHECK_SH);
    writeFileSync(path.join(source, 'src/app.ts'), 'export const app = 1;\n');
    writeFileSync(path.join(source, 'src/app.test.ts'), '// existing test\n');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'init');
    bare = path.join(tmp, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', source, bare]);
    egress = await startEgress();
  }, 300_000);

  afterAll(async () => {
    await egress?.stop();
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a two-subtask ticket produces four commits in order, pushes them, and ends at REVIEW', async () => {
    const r = await rig('tdd-ok');
    const outcomes = await drive(r);
    expect(outcomes.at(-1)).toEqual({ kind: 'transition', to: 'REVIEW', reason: 'Every subtask is done' });
    expect(log(r)).toEqual([`test(${r.key}): Add the export service`, `feat(${r.key}): Add the export service`, `test(${r.key}): Add the export endpoint`, `feat(${r.key}): Add the export endpoint`]);
    for (const id of r.subtaskIds) expect(await subtask(id)).toMatchObject({ status: 'DONE', fixRounds: 0 });
    const branch = (await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).branch as string;
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim()).toBe(sh(r.ws, 'rev-parse', 'HEAD'));
    // Every stage was a real container run, recorded and cleaned up.
    const runs = await prisma.stageRun.findMany({ where: { ticketId: r.ticketId }, orderBy: { startedAt: 'asc' } });
    expect(runs.map((x) => [x.stage, x.status])).toEqual([['tests', 'succeeded'], ['implement', 'succeeded'], ['tests', 'succeeded'], ['implement', 'succeeded']]);
    expect(await leftoverAgentContainers()).toEqual([]);
  }, 300_000);

  it('a draft PR is opened after the first subtask, with the description template', async () => {
    const r = await rig('tdd-ok');
    await prisma.project.update({ where: { id: r.projectId }, data: { repoUrl: 'https://github.com/acme/billing' } });
    expect(r.github.opened).toHaveLength(0);
    await drive(r, async () => (await subtask(r.subtaskIds[0] as string)).status === 'DONE');
    expect((await subtask(r.subtaskIds[1] as string)).status).toBe('PENDING'); // the second subtask has not started
    expect(r.github.opened).toHaveLength(1);
    expect(r.github.opened[0]).toMatchObject({ repo: 'acme/billing', base: 'dev', title: `${r.key}: Export bookings` });
    expect(r.github.opened[0]?.body).toContain('## Fix implemented\n- Add the export service (`');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).prNumber).toBe(100);
    await drive(r);
    expect(r.github.opened).toHaveLength(1); // still just one
  }, 300_000);

  it('a failing implementation triggers fix rounds and then needs_help', async () => {
    const r = await rig('tdd-bad-impl', { subtasks: 1 });
    const outcomes = await drive(r);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((outcomes.at(-1) as { note: string }).note).toContain('still fails after 2 fix round(s)');
    expect((outcomes.at(-1) as { note: string }).note).toContain('is not implemented');
    expect(await subtask(r.subtaskIds[0] as string)).toMatchObject({ status: 'VERIFY_GREEN', fixRounds: 2 });
    const fixes = await prisma.stageRun.findMany({ where: { ticketId: r.ticketId, stage: 'fix' }, orderBy: { startedAt: 'asc' } });
    expect(fixes.map((f) => [f.round, f.reason])).toEqual([[1, 'tests'], [2, 'tests']]);
    expect(log(r)).toEqual([`test(${r.key}): Add the export service`]); // the test commit only; no feat commit
  }, 300_000);

  it('tampering with a test file is undone and the original tests decide', async () => {
    const r = await rig('tdd-tamper', { subtasks: 1 });
    const outcomes = await drive(r);
    // The implementation stayed broken and the test was rewritten to always pass; restoring the test makes the original decide.
    expect(outcomes.at(-1)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    const s = await subtask(r.subtaskIds[0] as string);
    expect(s.status).not.toBe('DONE');
    expect(readFileSync(path.join(r.ws, 'src/f1.test.ts'), 'utf8')).not.toContain('ALWAYS_PASS');
    expect(sh(r.ws, 'show', `${s.testCommit}:src/f1.test.ts`)).not.toContain('ALWAYS_PASS');
    expect(sh(r.ws, 'status', '--porcelain')).not.toContain('f1.test.ts');
    expect((await prisma.event.findMany({ where: { ticketId: r.ticketId, type: 'git' } })).some((e) => e.message.includes('restored test file(s) modified by the implementation: src/f1.test.ts'))).toBe(true);
  }, 300_000);

  it('verify-red invalid (module not found) retries the tests stage once, then holds', async () => {
    const r = await rig('tdd-red-invalid', { subtasks: 1 });
    const outcomes = await drive(r);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((outcomes.at(-1) as { note: string }).note).toContain('still invalid after the retry');
    const testsRuns = await prisma.stageRun.findMany({ where: { ticketId: r.ticketId, stage: 'tests' }, orderBy: { startedAt: 'asc' } });
    expect(testsRuns.map((x) => [x.round, x.status])).toEqual([[0, 'succeeded'], [1, 'succeeded']]);
    expect(log(r)).toEqual([]); // no test commit was made
    expect((await subtask(r.subtaskIds[0] as string)).testCommit).toBeNull();
  }, 300_000);

  it('a repository without a typecheck command works, with a warning', async () => {
    const r = await rig('tdd-ok', { project: { typecheckCmd: '' } });
    const outcomes = await drive(r);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'transition', to: 'REVIEW' });
    expect(log(r)).toHaveLength(4);
    expect((await prisma.event.findMany({ where: { ticketId: r.ticketId } })).some((e) => e.message.includes('typecheck command is empty'))).toBe(true);
  }, 300_000);

  it('a rejected push puts the ticket on hold (needs_help) and never forces', async () => {
    const r = await rig('tdd-ok', { subtasks: 1 });
    const branch = (await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).branch as string;
    const other = path.join(tmp, `other-${n}`);
    execFileSync('git', ['clone', '-q', bare, other]);
    sh(other, 'checkout', '-q', '-b', branch);
    writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'someone else');
    sh(other, 'push', '-q', 'origin', branch);
    const theirs = execFileSync('git', ['--git-dir', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim();
    const outcomes = await drive(r);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((outcomes.at(-1) as { note: string }).note).toContain('rejected');
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim()).toBe(theirs);
  }, 300_000);
});
