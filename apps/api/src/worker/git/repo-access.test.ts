import { describe, expect, it, vi } from 'vitest';
import { checkRepoAccess } from './repo-access';

const answer = (status: number, body: unknown = {}) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const URL = 'https://github.com/acme/billing';

describe('checkRepoAccess', () => {
  it('returns null when the token can read and push', async () => {
    const f = answer(200, { permissions: { push: true } });
    expect(await checkRepoAccess(URL, 'ghp_x', { fetch: f, apiUrl: 'https://api.test' })).toBeNull();
    expect(f.mock.calls[0]?.[0]).toBe('https://api.test/repos/acme/billing');
    expect(f.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer ghp_x');
  });
  it('returns null when GitHub does not report permissions', async () => {
    expect(await checkRepoAccess(URL, 't', { fetch: answer(200, {}) })).toBeNull();
  });
  it('explains a token that can read but not push', async () => {
    expect(await checkRepoAccess(URL, 't', { fetch: answer(200, { permissions: { push: false } }) })).toContain('cannot push');
  });
  it('explains 403 and 404 (repository not visible to the token), naming the repo and what to change', async () => {
    for (const status of [403, 404]) {
      const msg = await checkRepoAccess(URL, 't', { fetch: answer(status) });
      expect(msg).toContain('acme/billing');
      expect(msg).toContain('Repository access');
      expect(msg).toContain('Contents: Read and write');
    }
  });
  it('explains a rejected token', async () => {
    expect(await checkRepoAccess(URL, 't', { fetch: answer(401) })).toContain('rejected the token');
  });
  it('stays out of the way: non-GitHub URLs, no token, server errors and network failures', async () => {
    const f = answer(404);
    expect(await checkRepoAccess('file:///tmp/remote.git', 't', { fetch: f })).toBeNull();
    expect(await checkRepoAccess(URL, '', { fetch: f })).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await checkRepoAccess(URL, 't', { fetch: answer(502) })).toBeNull();
    expect(await checkRepoAccess(URL, 't', { fetch: vi.fn().mockRejectedValue(new Error('offline')) })).toBeNull();
  });
});
