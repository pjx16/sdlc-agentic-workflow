import type { SetupStatus } from '@sdlc/shared';

const API_URL = process.env.API_URL ?? 'http://api:4000';

/** The public part of GET /setup/status (no session needed): has the admin account been created? */
export async function adminCreated(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/setup/status`, { cache: 'no-store' });
    if (!res.ok) return true; // fail open to the login page
    return ((await res.json()) as { adminCreated: boolean }).adminCreated;
  } catch {
    return true;
  }
}

/** Human label for each missing credential, for the banner. */
export const MISSING_LABELS: Record<string, string> = {
  claude_token: 'the Claude token',
  github_token: 'the GitHub token',
  git_author_name: 'the git author name',
  git_author_email: 'the git author email',
  jira_base_url: 'the Jira base URL',
  jira_email: 'the Jira email',
  jira_api_token: 'the Jira API token',
};

export type { SetupStatus };
