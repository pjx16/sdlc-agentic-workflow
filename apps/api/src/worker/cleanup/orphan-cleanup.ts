import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Housekeeper } from '../loop/worker-loop';
import { WorkerConfig } from '../worker-config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes the mirror and workspaces of projects that were deleted in the dashboard (the API cannot write to DATA_DIR).
 * Only folders named like a project id and absent from the database are touched.
 */
@Injectable()
export class OrphanCleanup implements Housekeeper {
  readonly name = 'orphan-cleanup';
  readonly intervalMs = 30_000;
  private readonly logger = new Logger(OrphanCleanup.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
  ) {}

  async check(): Promise<void> {
    const removed = await this.run();
    if (removed > 0) this.logger.log(`Removed the files of ${removed} deleted project(s)`);
  }

  async run(): Promise<number> {
    const known = new Set((await this.prisma.project.findMany({ select: { id: true } })).map((p) => p.id));
    let removed = 0;
    for (const [folder, idOf] of [
      ['workspaces', (name: string) => name],
      ['mirrors', (name: string) => name.replace(/\.git$/, '')],
    ] as const) {
      const root = path.join(this.config.dataDir, folder);
      if (!existsSync(root)) continue;
      for (const name of await readdir(root)) {
        const id = idOf(name);
        if (!UUID.test(id) || known.has(id)) continue;
        const target = path.join(root, name);
        if (!target.startsWith(root + path.sep)) continue; // defence in depth
        try {
          await rm(target, { recursive: true, force: true });
          removed++;
        } catch (err) {
          this.logger.warn(`Could not remove ${target}: ${String(err)}`);
        }
      }
    }
    return removed;
  }
}
