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
import { WorkspaceService } from '../git/workspace.service';
import { featureKeyOf, lookup } from '../kb/kb-index';
import { VerifyService } from '../verify/verify.service';
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
      },
      { workspacePath: ws, subtaskId: subtask.id, round: await this.testsRoundsDone(subtask.id), validate: (envelope) => this.validateTests(envelope, ws) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'tests', result);

    const testFiles = ((result.envelope.data as { testFiles: string[] }).testFiles).map((f) => f.replace(/^\.\//, ''));
    await this.setStatus(subtask.id, 'VERIFY_RED', { testFiles: testFiles as Prisma.InputJsonValue });
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
