import { Injectable } from '@nestjs/common';
import type { JiraClient } from './jira-client';
import { JiraRestClient } from './jira-rest-client';

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
