import { Module } from '@nestjs/common';
import { JiraClients } from '../jira/jira-clients';
import { JiraModule } from '../jira/jira.module';
import { LoggingModule } from '../logging.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalPoller } from '../jira/approval-poller';
import { StateMachine } from '../state/state-machine.service';
import { StateModule } from '../state/state.module';
import { AgentRunner } from './agent-runner/agent-runner';
import { FileLogSink } from './agent-runner/file-log-sink';
import { LOG_SINK } from './agent-runner/log-sink';
import { PrismaStageRunStore, STAGE_RUN_STORE } from './agent-runner/stage-run-store';
import { CONTAINER_ENGINE, DockerodeEngine } from './agent-runner/container-engine';
import { ContainerRunner } from './agent-runner/container-runner';
import { MirrorService } from './git/mirror.service';
import { VerifyService } from './verify/verify.service';
import { IntakePoller } from './intake/intake-poller';
import { RestartRecovery } from './loop/restart-recovery';
import { WorkerLoop } from './loop/worker-loop';
import { WorkerConfig } from './worker-config';
import { WorkerRunner } from './worker-runner';

/** The worker shares the database but has no HTTP surface and needs no dashboard credentials. */
@Module({
  imports: [LoggingModule, PrismaModule, StateModule, JiraModule],
  providers: [{ provide: WorkerConfig, useFactory: () => new WorkerConfig() }, MirrorService,
    { provide: CONTAINER_ENGINE, useFactory: () => new DockerodeEngine() },
    ContainerRunner,
    { provide: STAGE_RUN_STORE, useClass: PrismaStageRunStore },
    { provide: LOG_SINK, useClass: FileLogSink },
    AgentRunner,
    VerifyService,
    { provide: IntakePoller, useFactory: (prisma: PrismaService, clients: JiraClients) => new IntakePoller(prisma, clients), inject: [PrismaService, JiraClients] },
    ApprovalPoller,
    RestartRecovery,
    {
      provide: WorkerLoop,
      useFactory: (prisma: PrismaService, mirrors: MirrorService, intake: IntakePoller, approvals: ApprovalPoller, states: StateMachine) => new WorkerLoop(prisma, mirrors, intake, approvals, states, []),
      inject: [PrismaService, MirrorService, IntakePoller, ApprovalPoller, StateMachine],
    },
    WorkerRunner,
  ],
})
export class WorkerModule {}
