import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, type StageEnvelope, type SubtaskStatus } from '@sdlc/shared';
import type { Prisma, Subtask, Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { SubtaskInfo } from '../agent-runner/context-builder';
import { changedFilesSync } from '../git/changes';
import { CommitGuardError, describeViolations, squashAgentCommits, workspaceViolationsSync } from '../git/commit-guard';
import { PushRejectedError } from '../git/commit';
import { GitRunner } from '../git/git-runner';
import { makeWritableForAgent } from '../git/workspace';
import { WorkspaceService, installedHash, manifestHash, recordInstalled } from '../git/workspace.service';
import { featureKeyOf, lookup } from '../kb/kb-index';
import { decideGreen, decideRed } from '../verify/verify-decisions';
import { type CmdResult, VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepOutcome } from './step-handler';
import { checkTestFiles, isSafeRelativePath, isTestFile, pickExampleTestFile } from './test-patterns';

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const asNumbers = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : []);

export function toSubtaskInfo(s: Subtask): SubtaskInfo {
  return { seq: s.seq, title: s.title, description: s.description, acceptanceCriteria: asStrings(s.acceptanceCriteria), files: asStrings(s.files), dependsOn: asNumbers(s.dependsOn) };
}

/** The per-step logic of the subtask loop (BUILD_PLAN F9). One method per step; each runs at most one AI stage. */
@Injectable()
export class SubtaskStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitRunner,
    private readonly verify: VerifyService,
    private readonly config: WorkerConfig,
  ) {}

  protected setStatus(id: string, status: SubtaskStatus, extra: Prisma.SubtaskUpdateInput = {}) {
    return this.prisma.subtask.update({ where: { id }, data: { status, ...extra } });
  }

  protected async project(ticket: Ticket) {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    return { project, settings: ProjectSettingsSchema.parse(project.settings) };
  }

  /** The commit guard as part of a stage's output validation: a violation fails the attempt (F9, BUILD_PLAN 6.8). */
  protected guardMessage(ws: string): string | null {
    const violations = workspaceViolationsSync(ws);
    return violations.length > 0 ? describeViolations(violations) : null;
  }

  protected head(ws: string): Promise<string> {
    return this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
  }

  /** If the agent committed on its own, put those commits back so the orchestrator commits (F9). */
  protected async squashAgentCommitsAfterStage(ticket: Ticket, ws: string, preStageHead: string): Promise<void> {
    const n = await squashAgentCommits(this.git, ws, preStageHead);
    if (n > 0) await this.warn(ticket, `Warning: the agent made ${n} commit(s) of its own; they were squashed back and will be committed by the orchestrator`);
  }

  /** The KB doc of the ticket's feature, if there is one. */
  protected async kbDoc(ticket: Ticket, ws: string, kbDir: string): Promise<string | undefined> {
    return (await lookup(ws, kbDir, featureKeyOf(ticket))).match?.content;
  }

  /** How many `tests` stage runs for this subtask have succeeded: 0 on the first pass, 1 after one invalid red (the retry). */
  protected testsRoundsDone(subtaskId: string): Promise<number> {
    return this.prisma.stageRun.count({ where: { subtaskId, stage: 'tests', status: 'succeeded' } });
  }

  /**
   * `tests` stage (read-write workspace): tests and the minimal stubs needed to compile. The orchestrator checks that
   * `testFiles` exist and match the test patterns and that every new or modified test file is listed (F9).
   */
  async tests(ticket: Ticket, subtask: Subtask): Promise<StepOutcome> {
    const { project } = await this.project(ticket);
    const ws = this.launcher.workspaceOf(ticket);
    if (subtask.status === 'PENDING') await this.setStatus(subtask.id, 'TESTS');
    await makeWritableForAgent(ws);

    const preHead = await this.head(ws);
    const tracked = execFileSync('git', ['ls-files'], { cwd: ws, encoding: 'utf8' }).split('\n').filter(Boolean);
    const info = toSubtaskInfo(subtask);
    const result = await this.launcher.launch(
      ticket,
      'tests',
      {
        ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
        plan: ticket.planMarkdown ?? undefined,
        subtask: info,
        kbDoc: await this.kbDoc(ticket, ws, project.kbDir),
        exampleTestFile: pickExampleTestFile(tracked, info.files[0]),
        ...(subtask.status === 'TESTS' && subtask.lastFailure ? { previousAttempt: subtask.lastFailure } : {}),
      },
      { workspacePath: ws, subtaskId: subtask.id, round: await this.testsRoundsDone(subtask.id), validate: (envelope) => this.validateTests(envelope, ws) ?? (envelope.status === 'done' ? this.guardMessage(ws) : null) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'tests', result);
    await this.squashAgentCommitsAfterStage(ticket, ws, preHead);

    const testFiles = ((result.envelope.data as { testFiles: string[] }).testFiles).map((f) => f.replace(/^\.\//, ''));
    await this.setStatus(subtask.id, 'VERIFY_RED', { testFiles: testFiles as Prisma.InputJsonValue, lastFailure: null });
    return { kind: 'continue' };
  }

  // ------------------------------------------------------------------ verification helpers

  private async verifyTimeoutSec(): Promise<number> {
    return (await this.prisma.globalSettings.findUnique({ where: { id: 'global' } }))?.verifyTimeoutSec ?? 600;
  }

  private async warn(ticket: Ticket, message: string): Promise<void> {
    await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: message.slice(0, 500) } });
  }

  /** Runs the project's typecheck command, or skips it with a warning when it is empty (F2). */
  protected async runTypecheck(ticket: Ticket, ws: string, typecheckCmd: string, label: string): Promise<CmdResult | null> {
    if (typecheckCmd.trim() === '') {
      await this.warn(ticket, 'Warning: the typecheck command is empty, so the typecheck was skipped');
      return null;
    }
    return this.verify.runCmd({ name: `sdlc-typecheck-${ticket.key}-${label}-${Date.now()}`, workspace: ws, cmd: typecheckCmd, timeoutSec: await this.verifyTimeoutSec() });
  }

  /** Runs the targeted tests (`{files}` replaced by the given files). */
  protected async runTargeted(ticket: Ticket, ws: string, testCmdTemplate: string, files: readonly string[], label: string): Promise<CmdResult> {
    return this.verify.runCmd({ name: `sdlc-tests-${ticket.key}-${label}-${Date.now()}`, workspace: ws, cmd: testCmdTemplate, files, timeoutSec: await this.verifyTimeoutSec() });
  }

  /**
   * Installs dependencies again if package.json or a lockfile changed since the last install (F9). Returns null when nothing was
   * needed (or the install command is empty), otherwise the install result.
   */
  protected async installIfChanged(ticket: Ticket, ws: string, installCmd: string): Promise<CmdResult | null> {
    if (installedHash(ws) === manifestHash(ws)) return null;
    if (installCmd.trim() === '') {
      await this.warn(ticket, 'Warning: package.json or a lockfile changed but the install command is empty');
      return null;
    }
    const result = await this.verify.runCmd({ name: `sdlc-install-${ticket.key}-${Date.now()}`, workspace: ws, cmd: installCmd, timeoutSec: await this.verifyTimeoutSec() });
    if (result.ok) recordInstalled(ws);
    await makeWritableForAgent(ws);
    return result;
  }

  /** A one-line, bounded subtitle for a commit message. */
  protected oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  // ------------------------------------------------------------------ verify-red

  /**
   * Verify-red (F9): the typecheck passes AND the targeted tests fail AND their output matches none of `verify.redInvalidPatterns`.
   * Valid: commit `test(<KEY>): <title>` and record `testCommit`. Invalid: run `tests` once more, then hold (`needs_help`).
   */
  async verifyRed(ticket: Ticket, subtask: Subtask): Promise<StepOutcome> {
    const { project, settings } = await this.project(ticket);
    const ws = this.launcher.workspaceOf(ticket);
    const files = asStrings(subtask.testFiles);
    if (files.length === 0) return { kind: 'hold', reason: 'needs_help', note: `Subtask ${subtask.seq} has no test files to verify` };

    const install = await this.installIfChanged(ticket, ws, project.installCmd);
    if (install && !install.ok) return { kind: 'hold', reason: 'needs_help', note: `The dependency install failed after the tests were written:\n${install.tail.split('\n').slice(-5).join('\n')}`.slice(0, 500) };

    const typecheck = await this.runTypecheck(ticket, ws, project.typecheckCmd, `red${subtask.seq}`);
    const tests = await this.runTargeted(ticket, ws, project.testCmdTemplate, files, `red${subtask.seq}`);
    const decision = decideRed({ typecheck, tests, invalidPatterns: settings.verify.redInvalidPatterns });

    if (!decision.valid) {
      const rounds = await this.testsRoundsDone(subtask.id);
      if (rounds >= 2) return { kind: 'hold', reason: 'needs_help', note: `Verify-red is still invalid after the retry: ${decision.reason}`.slice(0, 500) };
      await this.setStatus(subtask.id, 'TESTS', { lastFailure: decision.reason.slice(0, 4000) });
      await this.warn(ticket, `Verify-red invalid for subtask ${subtask.seq}: ${decision.reason.split('\n')[0]}; running the tests stage again`);
      return { kind: 'continue' };
    }

    const commit = await this.workspaces.commit(ticket.id, `test(${ticket.key}): ${this.oneLine(subtask.title)}`);
    const testCommit = commit.committed ? commit.sha : await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    await this.setStatus(subtask.id, 'IMPLEMENT', { testCommit, lastFailure: null });
    return { kind: 'continue' };
  }

  // ------------------------------------------------------------------ implement

  /**
   * `implement` stage (read-write workspace): makes the given tests pass by editing files only. With the tests stage off it is also
   * told to write tests, and the test files it changed become the subtask's targeted tests (F2, F9).
   */
  async implement(ticket: Ticket, subtask: Subtask): Promise<StepOutcome> {
    const { project, settings } = await this.project(ticket);
    const ws = this.launcher.workspaceOf(ticket);
    const testsOn = settings.stages.tests.enabled;
    if (subtask.status === 'PENDING') await this.setStatus(subtask.id, 'IMPLEMENT');
    await makeWritableForAgent(ws);
    const preHead = await this.head(ws);

    const result = await this.launcher.launch(
      ticket,
      'implement',
      {
        ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
        plan: ticket.planMarkdown ?? undefined,
        subtask: toSubtaskInfo(subtask),
        kbDoc: await this.kbDoc(ticket, ws, project.kbDir),
        testFiles: asStrings(subtask.testFiles),
        writeTests: !testsOn,
      },
      { workspacePath: ws, subtaskId: subtask.id, validate: (envelope) => (envelope.status === 'done' ? this.guardMessage(ws) : null) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'implement', result);
    await this.squashAgentCommitsAfterStage(ticket, ws, preHead);

    const extra: Prisma.SubtaskUpdateInput = { lastFailure: null };
    if (!testsOn) {
      const changedTests = changedFilesSync(ws).filter((c) => !c.status.includes('D') && isTestFile(c.path)).map((c) => c.path);
      extra.testFiles = changedTests as Prisma.InputJsonValue;
    }
    await this.setStatus(subtask.id, 'VERIFY_GREEN', extra);
    return { kind: 'continue' };
  }

  // ------------------------------------------------------------------ verify-green

  /**
   * Test files modified since `testCommit` are restored (`git checkout <testCommit> -- <files>`), so the original tests decide
   * and an implementation cannot pass by editing them (F9). Returns the restored paths.
   */
  protected async restoreTestFiles(ticket: Ticket, ws: string, testCommit: string, files: readonly string[]): Promise<string[]> {
    if (files.length === 0) return [];
    const changed = (await this.git.out(['diff', '--name-only', testCommit, '--', ...files], { cwd: ws })).split('\n').filter(Boolean);
    if (changed.length === 0) return [];
    await this.git.run(['checkout', testCommit, '--', ...changed], { cwd: ws });
    await this.warn(ticket, `Warning: restored test file(s) modified by the implementation: ${changed.join(', ')}`);
    return changed;
  }

  /** The files the targeted tests run on: the subtask's test files, or (tests stage off) the changed test files, if any. */
  protected targetedFiles(subtask: Subtask, testsEnabled: boolean, ws: string): string[] {
    if (testsEnabled) return asStrings(subtask.testFiles);
    const recorded = asStrings(subtask.testFiles);
    if (recorded.length > 0) return recorded;
    return changedFilesSync(ws).filter((c) => !c.status.includes('D') && isTestFile(c.path)).map((c) => c.path);
  }

  /**
   * Verify-green (F9): restore tampered test files, install again if package.json or a lockfile changed, typecheck must pass, and
   * the targeted tests must pass. With the tests stage off and no changed test files, only the typecheck runs.
   */
  async verifyGreen(ticket: Ticket, subtask: Subtask): Promise<StepOutcome> {
    const { project, settings } = await this.project(ticket);
    const ws = this.launcher.workspaceOf(ticket);
    const testsOn = settings.stages.tests.enabled;

    if (testsOn && subtask.testCommit) await this.restoreTestFiles(ticket, ws, subtask.testCommit, asStrings(subtask.testFiles));

    const install = await this.installIfChanged(ticket, ws, project.installCmd);
    if (install && !install.ok) return { kind: 'hold', reason: 'needs_help', note: `The dependency install failed:\n${install.tail.split('\n').slice(-5).join('\n')}`.slice(0, 500) };

    const typecheck = await this.runTypecheck(ticket, ws, project.typecheckCmd, `green${subtask.seq}`);
    const files = this.targetedFiles(subtask, testsOn, ws);
    const tests = typecheck && !typecheck.ok ? null : files.length > 0 ? await this.runTargeted(ticket, ws, project.testCmdTemplate, files, `green${subtask.seq}`) : null;
    const decision = decideGreen({ typecheck, tests });

    if (!decision.ok) return this.greenFailed(ticket, subtask, decision.output, settings.limits.maxTestFixRounds);
    return this.completeSubtask(ticket, subtask);
  }

  /**
   * What happens when verify-green fails (F9): up to `maxTestFixRounds` times the subtask goes to FIXING with the last 60 lines of
   * the failure output; after that the ticket is held (`needs_help`).
   */
  protected async greenFailed(ticket: Ticket, subtask: Subtask, output: string, maxRounds: number): Promise<StepOutcome> {
    const tail = output.split('\n').slice(-60).join('\n');
    if (subtask.fixRounds >= maxRounds) {
      await this.prisma.subtask.update({ where: { id: subtask.id }, data: { lastFailure: tail } });
      return { kind: 'hold', reason: 'needs_help', note: `Subtask ${subtask.seq} still fails after ${subtask.fixRounds} fix round(s):\n${tail.split('\n').slice(-5).join('\n')}`.slice(0, 500) };
    }
    await this.setStatus(subtask.id, 'FIXING', { lastFailure: tail });
    await this.warn(ticket, `Verify-green failed for subtask ${subtask.seq}; fix round ${subtask.fixRounds + 1} of ${maxRounds}`);
    return { kind: 'continue' };
  }

  // ------------------------------------------------------------------ fix

  /**
   * `fix` stage (read-write workspace): given the failure output of verify-green (the last 60 lines) and the subtask, repairs the
   * implementation. The run is recorded with reason `tests`. Then verify-green runs again (F9).
   */
  async fix(ticket: Ticket, subtask: Subtask): Promise<StepOutcome> {
    const ws = this.launcher.workspaceOf(ticket);
    await makeWritableForAgent(ws);
    const round = subtask.fixRounds + 1;
    const preHead = await this.head(ws);
    const result = await this.launcher.launch(
      ticket,
      'fix',
      { failureOutput: subtask.lastFailure ?? '', subtask: toSubtaskInfo(subtask) },
      { workspacePath: ws, subtaskId: subtask.id, round, reason: 'tests', validate: (envelope) => (envelope.status === 'done' ? this.guardMessage(ws) : null) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'fix', result);
    await this.squashAgentCommitsAfterStage(ticket, ws, preHead);
    await this.setStatus(subtask.id, 'VERIFY_GREEN', { fixRounds: round });
    return { kind: 'continue' };
  }

  /**
   * The subtask passed verification: commit `feat(<KEY>): <title>`, record `featCommit`, push (never forced; a rejected push holds
   * the ticket with needs_help), and mark the subtask DONE (F9). A push that was rejected is simply tried again after Resume: the
   * verification repeats, there is nothing new to commit, and the existing commit is pushed.
   */
  protected async completeSubtask(ticket: Ticket, subtask: Subtask): Promise<StepOutcome> {
    const ws = this.launcher.workspaceOf(ticket);
    let featCommit: string;
    try {
      const commit = await this.workspaces.commit(ticket.id, `feat(${ticket.key}): ${this.oneLine(subtask.title)}`);
      featCommit = commit.committed ? commit.sha : await this.head(ws);
    } catch (err) {
      if (err instanceof CommitGuardError) return { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500) };
      throw err;
    }
    try {
      await this.workspaces.push(ticket.id);
    } catch (err) {
      if (err instanceof PushRejectedError) return { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500) };
      throw err;
    }
    await this.setStatus(subtask.id, 'DONE', { featCommit, lastFailure: null });
    return { kind: 'continue' };
  }

  /** Orchestrator validation of the `tests` output. A message fails the attempt (BUILD_PLAN 6.8). */
  private validateTests(envelope: StageEnvelope, ws: string): string | null {
    if (envelope.status !== 'done') return null;
    const listed = (envelope.data as { testFiles?: string[] } | undefined)?.testFiles ?? [];
    const { problems } = checkTestFiles({
      listed,
      exists: (f) => isSafeRelativePath(f) && existsSync(path.join(ws, f)),
      changed: changedFilesSync(ws).filter((c) => !c.status.includes('D')).map((c) => c.path),
    });
    return problems.length > 0 ? problems.join('; ') : null;
  }
}
