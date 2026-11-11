import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MirrorService } from './git/mirror.service';
import { WorkerLoop } from './loop/worker-loop';
import { WorkerConfig } from './worker-config';
import { WorkerRunner } from './worker-runner';

/** The worker shares the database but has no HTTP surface and needs no dashboard credentials. */
@Module({
  imports: [LoggingModule, PrismaModule],
  providers: [{ provide: WorkerConfig, useFactory: () => new WorkerConfig() }, MirrorService, WorkerLoop, WorkerRunner],
})
export class WorkerModule {}
