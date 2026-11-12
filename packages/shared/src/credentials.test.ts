import { describe, expect, it } from 'vitest';
import { CREDENTIAL_KEYS, CredentialValueSchemas, type CredentialKey } from './credentials';

const cases: Record<CredentialKey, { ok: string; bad: string }> = {
  claude_token: { ok: 'sk-ant-oat01-abcdef', bad: 'abc' },
  github_token: { ok: 'ghp_abcdefghijklmnopqrstu', bad: 'ghp_short' },
  git_author_name: { ok: 'Dev Bot', bad: '' },
  git_author_email: { ok: 'bot@example.com', bad: 'not-an-email' },
  jira_base_url: { ok: 'https://acme.atlassian.net', bad: 'https://evil.example.com' },
  jira_email: { ok: 'me@example.com', bad: 'me' },
  jira_api_token: { ok: 'x'.repeat(24), bad: 'short' },
};

describe('credential schemas', () => {
  for (const { key } of CREDENTIAL_KEYS) {
    it(`${key}: accepts a valid value and rejects an invalid one`, () => {
      expect(CredentialValueSchemas[key].safeParse(cases[key].ok).success).toBe(true);
      expect(CredentialValueSchemas[key].safeParse(cases[key].bad).success).toBe(false);
    });
  }
  it('also accepts github_pat_ tokens and rejects other Jira hosts with a path', () => {
    expect(CredentialValueSchemas.github_token.safeParse('github_pat_abcdefghijklmnopqrstu').success).toBe(true);
    expect(CredentialValueSchemas.jira_base_url.safeParse('https://acme.atlassian.net.evil.io').success).toBe(false);
  });
});
