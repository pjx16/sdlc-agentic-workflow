import { Global, Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { JiraStatusSync } from '../jira/jira-status-sync';
import { SupportCoreModule } from '../support/support-core.module';
import { SupportTransitionListener } from '../support/support-listener';
import { PlanPageSync } from '../worker/plan-pages/plan-page-sync';
import { ConfluenceClients } from '../confluence/confluence-clients';
import { JiraClients } from '../jira/jira-clients';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine, TRANSITION_LISTENERS } from './state-machine.service';

/** The state machine, with the Jira status mapping applied after every transition. */
@Global()
@Module({
  imports: [JiraModule, SupportCoreModule],
  providers: [
    { provide: PlanPageSync, useFactory: (p: PrismaService, c: ConfluenceClients, j: JiraClients) => new PlanPageSync(p, c, j), inject: [PrismaService, ConfluenceClients, JiraClients] },
    { provide: TRANSITION_LISTENERS, useFactory: (jira: JiraStatusSync, support: SupportTransitionListener, pages: PlanPageSync) => [jira, support, pages], inject: [JiraStatusSync, SupportTransitionListener, PlanPageSync] },
    StateMachine,
  ],
  exports: [StateMachine, PlanPageSync],
})
export class StateModule {}
