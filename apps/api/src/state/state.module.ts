import { Global, Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { JiraStatusSync } from '../jira/jira-status-sync';
import { SupportCoreModule } from '../support/support-core.module';
import { SupportTransitionListener } from '../support/support-listener';
import { StateMachine, TRANSITION_LISTENERS } from './state-machine.service';

/** The state machine, with the Jira status mapping applied after every transition. */
@Global()
@Module({
  imports: [JiraModule, SupportCoreModule],
  providers: [{ provide: TRANSITION_LISTENERS, useFactory: (jira: JiraStatusSync, support: SupportTransitionListener) => [jira, support], inject: [JiraStatusSync, SupportTransitionListener] }, StateMachine],
  exports: [StateMachine],
})
export class StateModule {}
