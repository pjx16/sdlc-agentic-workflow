import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { CredentialsService } from '../credentials/credentials.service';
import { JiraClients } from '../jira/jira-clients';
import { JiraModule } from '../jira/jira.module';
import { LoggingModule } from '../logging.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalPoller } from '../jira/approval-poller';
import { StateMachine } from '../state/state-machine.service';
import { SubtasksService } from '../subtasks/subtasks.service';
import { StateModule } from '../state/state.module';
import { USAGE_GATE, UsageGate } from './usage/usage-gate';
import { AgentRunner } from './agent-runner/agent-runner';
import { FileLogSink } from './agent-runner/file-log-sink';
import { LOG_SINK } from './agent-runner/log-sink';
import { PrismaStageRunStore, STAGE_RUN_STORE } from './agent-runner/stage-run-store';
import { CONTAINER_ENGINE, DockerodeEngine } from './agent-runner/container-engine';
import { ContainerRunner } from './agent-runner/container-runner';
import { GitRunner } from './git/git-runner';
import { MirrorService } from './git/mirror.service';
import { WorkspaceService } from './git/workspace.service';
import { VerifyService } from './verify/verify.service';
import { IntakePoller } from './intake/intake-poller';
import { BreakdownHandler } from './pipeline/breakdown.handler';
import { GITHUB_CLIENT, GhCliClient, type GitHubClient } from './github/github-client';
import { InProgressHandler, SUBTASK_STEPS } from './pipeline/in-progress.handler';
import { PrService } from './pipeline/pr.service';
import { SubtaskStepsService } from './pipeline/subtask-steps.service';
import { PlanHandler } from './pipeline/plan.handler';
import { KB_BUILDER, KbHandler } from './pipeline/kb.handler';
import { KbBuildService } from './pipeline/kb-build.service';
import { KbUpdateService } from './pipeline/kb-update.service';
import { HumanReviewHandler, KbUpdateHandler } from './pipeline/kb-update.handler';
import { ReviewHandler } from './review/review.handler';
import { ReviewService } from './review/review.service';
import { StageLauncher } from './pipeline/stage-launcher';
import { NewTicketHandler } from './pipeline/new-ticket.handler';
import { STEP_HANDLERS, type StepHandler } from './pipeline/step-handler';
import { StageOutcomes } from './pipeline/stage-outcomes';
import { RestartRecovery } from './loop/restart-recovery';
import { HOUSEKEEPERS, type Housekeeper, WorkerLoop } from './loop/worker-loop';
import { HoldNotifier } from './ci/hold-notifier';
import { CiPoller } from './ci/ci-poller';
import { JiraStatusSync } from '../jira/jira-status-sync';
import { JiraMcpClient } from '../jira/jira-mcp-client';
import { JiraMcpStages } from './jira-mcp/jira-mcp-stages';
import { McpIntake } from './intake/mcp-intake';
import { CleanupService } from './cleanup/cleanup.service';
import { MergePoller } from './ci/merge-poller';
import { CiFixHandler } from './ci/ci-fix.handler';
import { WorkerConfig } from './worker-config';
import { WorkerRunner } from './worker-runner';

/** The worker shares the database but has no HTTP surface and needs no dashboard credentials. */
@Module({
  imports: [LoggingModule, PrismaModule, CredentialsModule, StateModule, JiraModule],
  providers: [{ provide: WorkerConfig, useFactory: () => new WorkerConfig() },
    MirrorService,
    { provide: GitRunner, useFactory: (creds: CredentialsService) => new GitRunner({ token: async () => (await creds.resolve()).github_token }), inject: [CredentialsService] },
    WorkspaceService,
    { provide: CONTAINER_ENGINE, useFactory: () => new DockerodeEngine() },
    ContainerRunner,
    { provide: STAGE_RUN_STORE, useClass: PrismaStageRunStore },
    { provide: LOG_SINK, useClass: FileLogSink },
    { provide: USAGE_GATE, useFactory: (prisma: PrismaService) => new UsageGate(prisma), inject: [PrismaService] },
    AgentRunner,
    { provide: JiraMcpStages, useFactory: (prisma: PrismaService, runner: AgentRunner, config: WorkerConfig) => new JiraMcpStages(prisma, runner, config), inject: [PrismaService, AgentRunner, WorkerConfig] },
    // Registers the MCP client with the shared JiraClients, so MCP-mode projects use it for intake and write-back.
    { provide: 'JIRA_MCP_REGISTRATION', useFactory: (clients: JiraClients, stages: JiraMcpStages) => clients.useMcp(new JiraMcpClient(stages)), inject: [JiraClients, JiraMcpStages] },
    VerifyService,
    { provide: IntakePoller, useFactory: (prisma: PrismaService, clients: JiraClients) => new IntakePoller(prisma, clients), inject: [PrismaService, JiraClients] },
    SubtasksService,
    ApprovalPoller,
    StageOutcomes,
    StageLauncher,
    KbBuildService,
    PlanHandler,
    BreakdownHandler,
    { provide: GITHUB_CLIENT, useFactory: (c: WorkerConfig, creds: CredentialsService) => new GhCliClient({ token: async () => (await creds.resolve()).github_token, tmpDir: c.dataDir }), inject: [WorkerConfig, CredentialsService] },
    PrService,
    SubtaskStepsService,
    { provide: SUBTASK_STEPS, useExisting: SubtaskStepsService },
    InProgressHandler,
    { provide: KB_BUILDER, useExisting: KbBuildService },
    KbUpdateService,
    KbUpdateHandler,
    HumanReviewHandler,
    ReviewService,
    ReviewHandler,
    CiFixHandler,
    HoldNotifier,
    { provide: CleanupService, useFactory: (p: PrismaService, c: WorkerConfig) => new CleanupService(p, c), inject: [PrismaService, WorkerConfig] },
    { provide: McpIntake, useFactory: (p: PrismaService, i: IntakePoller, a: ApprovalPoller, st: SubtasksService, sync: JiraStatusSync) => new McpIntake(p, i, undefined, a, st, sync), inject: [PrismaService, IntakePoller, ApprovalPoller, SubtasksService, JiraStatusSync] },
    { provide: CiPoller, useFactory: (p: PrismaService, st: StateMachine, pr: PrService, gh: GitHubClient, hn: HoldNotifier) => new CiPoller(p, st, pr, gh, undefined, hn), inject: [PrismaService, StateMachine, PrService, GITHUB_CLIENT, HoldNotifier] },
    { provide: MergePoller, useFactory: (p: PrismaService, st: StateMachine, gh: GitHubClient) => new MergePoller(p, st, gh), inject: [PrismaService, StateMachine, GITHUB_CLIENT] },
    { provide: HOUSEKEEPERS, useFactory: (ci: CiPoller, merge: MergePoller, mcp: McpIntake, cleanup: CleanupService): Housekeeper[] => [ci, merge, mcp, cleanup], inject: [CiPoller, MergePoller, McpIntake, CleanupService] },
    NewTicketHandler,
    KbHandler,
    { provide: STEP_HANDLERS, useFactory: (...handlers: StepHandler[]) => handlers, inject: [NewTicketHandler, KbHandler, PlanHandler, BreakdownHandler, InProgressHandler, ReviewHandler, KbUpdateHandler, HumanReviewHandler, CiFixHandler] },
    RestartRecovery,
    {
      provide: WorkerLoop,
      useFactory: (prisma: PrismaService, mirrors: MirrorService, intake: IntakePoller, approvals: ApprovalPoller, states: StateMachine, handlers: StepHandler[], housekeepers: Housekeeper[], holds: HoldNotifier) => new WorkerLoop(prisma, mirrors, intake, approvals, states, handlers, undefined, housekeepers, holds),
      inject: [PrismaService, MirrorService, IntakePoller, ApprovalPoller, StateMachine, STEP_HANDLERS, HOUSEKEEPERS, HoldNotifier],
    },
    WorkerRunner,
  ],
})
export class WorkerModule {}
