import { Injectable } from '@nestjs/common';
import { CredentialsService } from '../credentials/credentials.service';
import type { JiraClient } from './jira-client';
import { JiraRestClient } from './jira-rest-client';
import { JiraMcpError } from './jira-mcp-client';

/** The Jira credentials are missing: REST mode cannot work until JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set. */
export class JiraNotConfiguredError extends Error {
  constructor() {
    super('Jira is not configured: add the Jira base URL, email and API token in the dashboard (Settings → Connections) or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN');
    this.name = 'JiraNotConfiguredError';
  }
}

/** Gives out the Jira client, rebuilt whenever the Jira credentials change. Tests replace this provider with a fake. */
@Injectable()
export class JiraClients {
  private rest: JiraClient | null = null;
  private restKey = '';

  constructor(private readonly creds: CredentialsService) {}

  /** MCP mode needs the worker (it runs agent containers); the worker registers its client here. */
  private mcp: JiraClient | null = null;

  /** True in the worker: the API process cannot run the Jira stages. */
  hasMcp(): boolean {
    return this.mcp !== null;
  }

  useMcp(client: JiraClient): void {
    this.mcp = client;
  }

  /** The client for a project's `jiraMode` (`rest` or `mcp`). */
  async forMode(mode: 'rest' | 'mcp'): Promise<JiraClient> {
    if (mode === 'rest') return this.forRest();
    if (!this.mcp) throw new JiraMcpError('Jira MCP mode is only available in the worker');
    return this.mcp;
  }

  async forRest(): Promise<JiraClient> {
    const c = await this.creds.resolve();
    const key = [c.jira_base_url, c.jira_email, c.jira_api_token].join('\n');
    if (!this.rest || key !== this.restKey) {
      if (!c.jira_base_url || !c.jira_email || !c.jira_api_token) throw new JiraNotConfiguredError();
      this.rest = JiraRestClient.fromCredentials(c);
      this.restKey = key;
    }
    return this.rest;
  }
}
