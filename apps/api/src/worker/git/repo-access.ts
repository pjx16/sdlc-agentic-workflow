import { parseRepo } from '../github/github-client';

export interface RepoAccessOptions {
  fetch?: typeof fetch;
  apiUrl?: string;
}

const TIMEOUT_MS = 10_000;

/**
 * Asks GitHub whether the token can use the repository, so the project page says why it cannot instead of showing a raw git 403.
 * Returns null when access looks fine, the repository is not on GitHub (local test remotes), or GitHub could not be asked:
 * the clone then decides. Returns a message for the user otherwise.
 */
export async function checkRepoAccess(repoUrl: string, token: string, opts: RepoAccessOptions = {}): Promise<string | null> {
  let repo: string;
  try {
    repo = parseRepo(repoUrl);
  } catch {
    return null;
  }
  if (!token) return null;
  const api = (opts.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${api}/repos/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sdlc-agent', Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null; // offline or slow: let the clone report it
  }

  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as { permissions?: { push?: boolean } };
    // The pipeline pushes branches, so a token that can only read is not enough. `permissions` is absent for some token types; then assume fine.
    if (body.permissions?.push === false) {
      return `The GitHub token can read ${repo} but cannot push to it. Give it Contents: Read and write (fine-grained token), or the repo scope (classic token).`;
    }
    return null;
  }
  if (res.status === 401) return 'GitHub rejected the token (401). Check or replace it in Settings → Connections.';
  if (res.status === 404 || res.status === 403) {
    return (
      `The GitHub token cannot access ${repo} (GitHub answered ${res.status}). Either the repository does not exist, or the token is not allowed to see it. ` +
      'For a fine-grained token: add this repository under "Repository access" (and check the token\'s resource owner), and grant Contents: Read and write and Metadata: Read. ' +
      'For a classic token: it needs the repo scope (and SSO authorisation for an organisation).'
    );
  }
  return null; // 5xx, rate limits and the like: let the clone report it
}
