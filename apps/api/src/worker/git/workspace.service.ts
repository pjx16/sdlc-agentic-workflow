import { existsSync } from 'node:fs';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { TicketType } from '@sdlc/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { type CmdResult, VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { assertSafeKey, branchName } from './branch';
import { type CommitResult, commitAll, pushBranch } from './commit';
import { GitRunner } from './git-runner';
import { makeWritableForAgent, prepareWorkspace } from './workspace';

export interface WorkspaceResult {
  path: string;
  branch: string;
  created: boolean;
  /** Null when the install was not needed (an existing workspace with dependencies) or the command is empty. */
  install: CmdResult | null;
  /** Why no install ran, when that is worth telling the developer. */
  installSkipped?: 'empty_command' | 'already_installed';
}

/** Prepares a ticket's workspace, installs its dependencies, and records the branch (BUILD_PLAN 6.2, `Git.prepareWorkspace`). */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    private readonly git: GitRunner,
    private readonly verify: VerifyService,
  ) {}

  async prepare(ticketId: string): Promise<WorkspaceResult> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { project: true } });
    const { project } = ticket;
    if (project.mirrorStatus !== 'ok') throw new Error(`The repository mirror of "${project.name}" is not ready`);
    assertSafeKey(ticket.key);

    const branch = branchName({ key: ticket.key, title: ticket.title, type: ticket.type as TicketType });
    const prepared = await prepareWorkspace(this.git, {
      mirrorPath: this.config.mirrorPath(project.id),
      repoUrl: project.repoUrl,
      baseBranch: project.baseBranch,
      workspacePath: this.config.workspacePath(project.id, ticket.key),
      branch,
    });
    if (ticket.branch !== branch) await this.prisma.ticket.update({ where: { id: ticketId }, data: { branch } });
    await makeWritableForAgent(prepared.path);

    const result: WorkspaceResult = { ...prepared, install: null };
    const installCmd = project.installCmd.trim();
    if (installCmd === '') {
      result.installSkipped = 'empty_command';
      await this.prisma.event.create({ data: { ticketId, type: 'git', message: 'The install command is empty: dependencies were not installed' } });
      return result;
    }
    // node_modules stays inside the workspace, so an existing workspace that has it needs no new install.
    if (!prepared.created && existsSync(path.join(prepared.path, 'node_modules'))) {
      result.installSkipped = 'already_installed';
      return result;
    }
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    result.install = await this.verify.runCmd({ name: `sdlc-install-${ticket.key}-${Date.now()}`, workspace: prepared.path, cmd: installCmd, timeoutSec: settings?.verifyTimeoutSec ?? 600 });
    if (!result.install.ok) this.logger.warn(`Install failed for ${ticket.key}: ${result.install.tail.split('\n').slice(-3).join(' | ')}`);
    await makeWritableForAgent(prepared.path); // the install created files as the agent user
    return result;
  }

  /** `Git.commit(ticket, message)`: commits the workspace as the configured identity; hooks never run. */
  async commit(ticketId: string, message: string): Promise<CommitResult> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const result = await commitAll(this.git, this.config.workspacePath(ticket.projectId, ticket.key), message, { name: this.config.authorName, email: this.config.authorEmail });
    if (result.committed) await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Committed ${result.sha.slice(0, 8)}: ${message.split('\n')[0]}`.slice(0, 500) } });
    return result;
  }

  /** `Git.push(ticket)`: never forced. Throws PushRejectedError, which puts the ticket on hold (`needs_help`). */
  async push(ticketId: string): Promise<void> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!ticket.branch) throw new Error(`${ticket.key} has no branch yet`);
    await pushBranch(this.git, this.config.workspacePath(ticket.projectId, ticket.key), ticket.branch);
    await this.prisma.event.create({ data: { ticketId, type: 'git', message: `Pushed ${ticket.branch}` } });
  }
}
