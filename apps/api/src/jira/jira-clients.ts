import { Injectable } from '@nestjs/common';
import type { JiraClient } from './jira-client';
import { JiraRestClient } from './jira-rest-client';
import { JiraMcpError } from './jira-mcp-client';

/** The Jira credentials are missing: REST mode cannot work until JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set. */
export class JiraNotConfiguredError extends Error {
  constructor() {
    super('Jira is not configured: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN');
    this.name = 'JiraNotConfiguredError';
  }
}

/** Gives out the Jira client, built once from the environment. Tests replace this provider with a fake. */
@Injectable()
export class JiraClients {
  private rest: JiraClient | null = null;

  /** MCP mode needs the worker (it runs agent containers); the worker registers its client here. */
  private mcp: JiraClient | null = null;

  useMcp(client: JiraClient): void {
    this.mcp = client;
  }

  /** The client for a project's `jiraMode` (`rest` or `mcp`). */
  forMode(mode: 'rest' | 'mcp'): JiraClient {
    if (mode === 'rest') return this.forRest();
    if (!this.mcp) throw new JiraMcpError('Jira MCP mode is only available in the worker');
    return this.mcp;
  }

  forRest(): JiraClient {
    if (!this.rest) {
      try {
        this.rest = JiraRestClient.fromEnv();
      } catch {
        throw new JiraNotConfiguredError();
      }
    }
    return this.rest;
  }
}
