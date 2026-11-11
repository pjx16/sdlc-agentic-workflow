import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import type { Project } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkerConfig } from '../worker-config';

const run = promisify(execFile);
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

/** Used when GIT_ASKPASS is not set (local development); the worker image sets it. */
const DEFAULT_ASKPASS = path.resolve(__dirname, '../../../../../docker/worker/git-askpass-token');

/** Bare mirrors of project repositories (BUILD_PLAN 6.2). */
@Injectable()
export class MirrorService {
  private readonly logger = new Logger(MirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
  ) {}

  /** Clones the mirror for a pending project, checks the base branch, and records ok or failed. */
  async clone(project: Project): Promise<void> {
    const dir = this.config.mirrorPath(project.id);
    let error: string | null = null;
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      await this.git(['clone', '--mirror', '--', project.repoUrl, dir]);
      const hasBase = await this.git(['--git-dir', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${project.baseBranch}`]).then(
        () => true,
        () => false,
      );
      if (!hasBase) error = `Base branch "${project.baseBranch}" was not found in the repository`;
    } catch (err) {
      error = this.describe(err);
    }
    if (error) await rm(dir, { recursive: true, force: true });

    // Only record the result if the project was not edited (and re-queued) while the clone ran.
    const { count } = await this.prisma.project.updateMany({
      where: { id: project.id, mirrorStatus: 'pending', repoUrl: project.repoUrl, baseBranch: project.baseBranch },
      data: error ? { mirrorStatus: 'failed', mirrorError: error } : { mirrorStatus: 'ok', mirrorError: null },
    });
    if (count > 0) this.logger.log(error ? `Mirror for "${project.name}" failed: ${error}` : `Mirror for "${project.name}" is ready`);
  }

  /** `git remote update --prune`, run before every workspace preparation (used from milestone 4). */
  async update(projectId: string): Promise<void> {
    await this.git(['--git-dir', this.config.mirrorPath(projectId), 'remote', 'update', '--prune']);
  }

  private git(args: string[]) {
    return run('git', args, {
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // The token is only ever handed to git through the askpass helper, never in a URL or git config.
        GIT_ASKPASS: process.env.GIT_ASKPASS ?? DEFAULT_ASKPASS,
        GITHUB_TOKEN: this.config.githubToken,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  }

  private describe(err: unknown): string {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    let text = e.killed ? 'git clone timed out' : (e.stderr?.trim() || e.message || 'git clone failed');
    if (this.config.githubToken) text = text.split(this.config.githubToken).join('***');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return (lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? 'git clone failed').slice(0, MAX_ERROR_LENGTH);
  }
}
