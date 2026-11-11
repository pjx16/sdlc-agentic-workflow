import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, type StageEnvelope, type SubtaskStatus } from '@sdlc/shared';
import type { Prisma, Subtask, Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { SubtaskInfo } from '../agent-runner/context-builder';
import { changedFilesSync } from '../git/changes';
import { GitRunner } from '../git/git-runner';
import { makeWritableForAgent } from '../git/workspace';
import { WorkspaceService, installedHash, manifestHash, recordInstalled } from '../git/workspace.service';
import { featureKeyOf, lookup } from '../kb/kb-index';
import { decideRed } from '../verify/verify-decisions';
import { type CmdResult, VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepOutcome } from './step-handler';
import { checkTestFiles, isSafeRelativePath, pickExampleTestFile } from './test-patterns';

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
      { workspacePath: ws, subtaskId: subtask.id, round: await this.testsRoundsDone(subtask.id), validate: (envelope) => this.validateTests(envelope, ws) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'tests', result);

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
