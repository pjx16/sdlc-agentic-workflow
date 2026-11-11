import { Module } from '@nestjs/common';
import { ApprovalPoller } from './approval-poller';
import { JiraClients } from './jira-clients';
import { JiraStatusSync } from './jira-status-sync';

@Module({ providers: [JiraClients, JiraStatusSync, ApprovalPoller], exports: [JiraClients, JiraStatusSync, ApprovalPoller] })
export class JiraModule {}
