import { Module } from '@nestjs/common';
import { JiraClients } from './jira-clients';
import { JiraStatusSync } from './jira-status-sync';

/** The Jira client and the outbound status mapping. (The approval poller needs the state machine, so the worker owns it.) */
@Module({ providers: [JiraClients, JiraStatusSync], exports: [JiraClients, JiraStatusSync] })
export class JiraModule {}
