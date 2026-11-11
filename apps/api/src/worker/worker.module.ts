import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentRunner } from './agent-runner/agent-runner';
import { LOG_SINK, NullLogSink } from './agent-runner/log-sink';
import { PrismaStageRunStore, STAGE_RUN_STORE } from './agent-runner/stage-run-store';
import { CONTAINER_ENGINE, DockerodeEngine } from './agent-runner/container-engine';
import { ContainerRunner } from './agent-runner/container-runner';
import { MirrorService } from './git/mirror.service';
import { VerifyService } from './verify/verify.service';
import { WorkerLoop } from './loop/worker-loop';
import { WorkerConfig } from './worker-config';
import { WorkerRunner } from './worker-runner';

/** The worker shares the database but has no HTTP surface and needs no dashboard credentials. */
@Module({
  imports: [LoggingModule, PrismaModule],
  providers: [{ provide: WorkerConfig, useFactory: () => new WorkerConfig() }, MirrorService,
    { provide: CONTAINER_ENGINE, useFactory: () => new DockerodeEngine() },
    ContainerRunner,
    { provide: STAGE_RUN_STORE, useClass: PrismaStageRunStore },
    { provide: LOG_SINK, useClass: NullLogSink },
    AgentRunner,
    VerifyService,
    WorkerLoop,
    WorkerRunner,
  ],
})
export class WorkerModule {}
