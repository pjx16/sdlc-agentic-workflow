import { Global, Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { JiraStatusSync } from '../jira/jira-status-sync';
import { StateMachine, TRANSITION_LISTENERS } from './state-machine.service';

/** The state machine, with the Jira status mapping applied after every transition. */
@Global()
@Module({
  imports: [JiraModule],
  providers: [{ provide: TRANSITION_LISTENERS, useFactory: (jira: JiraStatusSync) => [jira], inject: [JiraStatusSync] }, StateMachine],
  exports: [StateMachine],
})
export class StateModule {}
