import { Injectable } from '@nestjs/common';
import { CredentialsService } from '../credentials/credentials.service';
import { ConfluenceNotConfiguredError, type ConfluenceClient } from './confluence-client';
import { ConfluenceRestClient } from './confluence-rest-client';

/** Gives out the Confluence client, rebuilt whenever the Atlassian credentials change. Tests replace this provider. */
@Injectable()
export class ConfluenceClients {
  private client: ConfluenceClient | null = null;
  private key = '';

  constructor(private readonly creds: CredentialsService) {}

  async forRest(): Promise<ConfluenceClient> {
    const c = await this.creds.resolve();
    const key = [c.jira_base_url, c.jira_email, c.jira_api_token].join('\n');
    if (!this.client || key !== this.key) {
      if (!c.jira_base_url || !c.jira_email || !c.jira_api_token) throw new ConfluenceNotConfiguredError();
      this.client = ConfluenceRestClient.fromCredentials(c);
      this.key = key;
    }
    return this.client;
  }
}
