import { Injectable } from '@nestjs/common';
import { CredentialValueSchemas, type CredentialKey } from '@sdlc/shared';
import { CredentialsService } from './credentials.service';

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface TesterOptions {
  githubApiUrl?: string;
  fetch?: typeof fetch;
}

export const TESTER_OPTIONS = Symbol('TESTER_OPTIONS');

const TIMEOUT_MS = 10_000;

/** Connection tests run in the API (it has outbound internet); the Claude token can only be verified by a stage run in the worker. */
@Injectable()
export class CredentialTester {
  private readonly githubApi: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly creds: CredentialsService,
    options: TesterOptions = {},
  ) {
    this.githubApi = (options.githubApiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async test(key: CredentialKey): Promise<TestResult> {
    const result = await this.run(key).catch((err): TestResult => ({ ok: false, message: `Could not reach the service: ${err instanceof Error ? err.message : String(err)}` }));
    // Only the stored value carries a verification state; an env value has no row, so this is a no-op for it.
    await this.creds.markVerified(key, result.ok ? null : result.message);
    return result;
  }

  private get(url: string, headers: Record<string, string>): Promise<Response> {
    return this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  private async run(key: CredentialKey): Promise<TestResult> {
    const c = await this.creds.resolve();
    switch (key) {
      case 'github_token': {
        if (!c.github_token) return { ok: false, message: 'No GitHub token is set' };
        const res = await this.get(`${this.githubApi}/user`, {
          Authorization: `Bearer ${c.github_token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sdlc-agent',
          Accept: 'application/vnd.github+json',
        });
        if (res.status === 200) return { ok: true, message: `Connected as ${((await res.json()) as { login?: string }).login ?? 'unknown'}` };
        if (res.status === 401) return { ok: false, message: 'GitHub rejected the token' };
        return { ok: false, message: `GitHub answered ${res.status}` };
      }
      case 'jira_base_url':
      case 'jira_email':
      case 'jira_api_token': {
        if (!c.jira_base_url || !c.jira_email || !c.jira_api_token) return { ok: false, message: 'Set the Jira base URL, email and API token first' };
        const res = await this.get(`${c.jira_base_url.replace(/\/+$/, '')}/rest/api/3/myself`, {
          Authorization: `Basic ${Buffer.from(`${c.jira_email}:${c.jira_api_token}`).toString('base64')}`,
          Accept: 'application/json',
        });
        if (res.status === 200) {
          const who = `Connected as ${((await res.json()) as { displayName?: string }).displayName ?? 'unknown'}`;
          // The same credential reaches Confluence; plans are published there when a project has a space. A problem is a note, not a failure.
          const wiki = await this.get(`${c.jira_base_url.replace(/\/+$/, '')}/wiki/api/v2/spaces?limit=1`, {
            Authorization: `Basic ${Buffer.from(`${c.jira_email}:${c.jira_api_token}`).toString('base64')}`,
            Accept: 'application/json',
          }).catch(() => null);
          return { ok: true, message: wiki && wiki.status === 200 ? who : `${who} (Confluence is not reachable with this credential, so plans will be posted to Jira)` };
        }
        if (res.status === 401 || res.status === 403) return { ok: false, message: 'Jira rejected the credentials' };
        return { ok: false, message: `Jira answered ${res.status}` };
      }
      case 'claude_token': {
        if (!c.claude_token) return { ok: false, message: 'No Claude token is set' };
        return CredentialValueSchemas.claude_token.safeParse(c.claude_token).success
          ? { ok: true, message: 'Format OK — verified on the first stage run' }
          : { ok: false, message: 'The token does not look like a Claude token' };
      }
      case 'git_author_name':
      case 'git_author_email':
        return CredentialValueSchemas[key].safeParse(c[key]).success ? { ok: true, message: 'OK' } : { ok: false, message: 'Not set or invalid' };
    }
  }
}
