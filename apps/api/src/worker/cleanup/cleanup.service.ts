import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Housekeeper } from '../loop/worker-loop';
import { WorkerConfig } from '../worker-config';

export interface CleanupResult {
  logsDeleted: number;
  workspacesDeleted: number;
}

const DAY_MS = 86_400_000;

/**
 * Housekeeping (F18), once a day: stage log files older than `logRetentionDays`, and the workspaces of tickets that have been DONE for
 * longer than `workspaceRetentionDays`. The workspace of a ticket that is not DONE is never deleted automatically.
 */
@Injectable()
export class CleanupService implements Housekeeper {
  readonly name = 'cleanup';
  readonly intervalMs = DAY_MS;
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<void> {
    const r = await this.run();
    if (r.logsDeleted > 0 || r.workspacesDeleted > 0) {
      const message = `Cleanup removed ${r.logsDeleted} log file(s) and ${r.workspacesDeleted} workspace(s)`;
      this.logger.log(message);
      await this.prisma.event.create({ data: { type: 'system', message } }).catch(() => undefined);
    }
  }

  async run(): Promise<CleanupResult> {
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const logDays = settings?.logRetentionDays ?? 30;
    const workspaceDays = settings?.workspaceRetentionDays ?? 7;
    const now = this.now();
    return { logsDeleted: await this.deleteOldLogs(new Date(now.getTime() - logDays * DAY_MS)), workspacesDeleted: await this.deleteOldWorkspaces(new Date(now.getTime() - workspaceDays * DAY_MS)) };
  }

  private async deleteOldLogs(before: Date): Promise<number> {
    const dir = path.join(this.config.dataDir, 'logs');
    if (!existsSync(dir)) return 0;
    let deleted = 0;
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.log')) continue; // only stage logs
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (info.isFile() && info.mtime < before) {
          await rm(file, { force: true });
          deleted++;
        }
      } catch (err) {
        this.logger.warn(`Could not remove ${file}: ${String(err)}`);
      }
    }
    return deleted;
  }

  /** DONE for longer than the retention: judged by the moment the ticket became DONE, falling back to its last update. */
  private async deleteOldWorkspaces(before: Date): Promise<number> {
    const tickets = await this.prisma.ticket.findMany({
      where: { status: 'DONE', updatedAt: { lt: before } },
      select: { id: true, projectId: true, key: true, updatedAt: true },
    });
    let deleted = 0;
    for (const t of tickets) {
      const done = await this.prisma.stateTransition.findFirst({ where: { ticketId: t.id, toStatus: 'DONE' }, orderBy: { at: 'desc' } });
      if ((done?.at ?? t.updatedAt) >= before) continue;
      const dir = this.config.workspacePath(t.projectId, t.key);
      // Defence in depth: only ever delete inside DATA_DIR/workspaces.
      if (!dir.startsWith(path.join(this.config.dataDir, 'workspaces') + path.sep) || !existsSync(dir)) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        deleted++;
      } catch (err) {
        this.logger.warn(`Could not remove the workspace ${dir}: ${String(err)}`);
      }
    }
    return deleted;
  }
}
