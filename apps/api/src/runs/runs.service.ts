import path from 'node:path';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RunsService {
  constructor(private readonly prisma: PrismaService) {}

  private async find(id: string) {
    // Ids are uuids; anything else cannot exist, and must never reach a file path.
    const run = ID_PATTERN.test(id) ? await this.prisma.stageRun.findUnique({ where: { id }, select: { id: true, status: true } }) : null;
    if (!run) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Run not found');
    return run;
  }

  /** The path of the run's log under DATA_DIR/logs, after checking the run exists. */
  async logFile(id: string): Promise<string> {
    const run = await this.find(id);
    return path.join(process.env.DATA_DIR ?? path.resolve('data'), 'logs', `${run.id}.log`);
  }

  async status(id: string): Promise<string | null> {
    const run = ID_PATTERN.test(id) ? await this.prisma.stageRun.findUnique({ where: { id }, select: { status: true } }) : null;
    return run?.status ?? null;
  }

  /** POST /runs/:id/kill: sets killRequested; the worker polls it and kills the container. */
  async kill(id: string): Promise<{ id: string; status: string; killRequested: true }> {
    const run = await this.find(id);
    if (run.status !== 'running') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'Only a running stage can be killed');
    }
    await this.prisma.stageRun.update({ where: { id }, data: { killRequested: true } });
    return { id, status: run.status, killRequested: true };
  }
}
