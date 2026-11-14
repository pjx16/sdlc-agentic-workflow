import { describe, expect, it } from 'vitest';
import { ConfluenceHttpError } from './confluence-client';
import { ConfluenceRestClient } from './confluence-rest-client';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
type Reply = { status?: number; json?: unknown; text?: string } | Error;

function make(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply;
    if (reply instanceof Error) throw reply;
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { client: new ConfluenceRestClient({ baseUrl: 'https://acme.atlassian.net/', email: 'me@acme.com', apiToken: 'tok' }, { fetch: impl }), calls };
}

describe('ConfluenceRestClient', () => {
  it('uses Basic auth on the Atlassian site', async () => {
    const { client, calls } = make([{ json: { results: [] } }]);
    await client.test();
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/wiki/api/v2/spaces?limit=1');
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.com:tok').toString('base64')}`);
  });

  it('lists only the global spaces where pages can be created, sorted by name', async () => {
    const canCreate = [{ operation: 'create', targetType: 'page' }, { operation: 'read', targetType: 'space' }];
    const { client, calls } = make([{ json: { results: [
      { key: 'ENG', name: 'Engineering', operations: canCreate },
      { key: 'RO', name: 'Read only', operations: [{ operation: 'read', targetType: 'space' }] },
      { key: 'ABC', name: 'Apps', operations: canCreate },
    ] } }]);
    expect(await client.listWritableSpaces()).toEqual([{ key: 'ABC', name: 'Apps' }, { key: 'ENG', name: 'Engineering' }]);
    expect(calls[0]?.url).toContain('/wiki/rest/api/space?type=global');
    expect(calls[0]?.url).toContain('expand=operations');
  });

  it('finds the parent page by title and does not create a second one', async () => {
    const { client, calls } = make([{ json: { results: [{ id: '7', key: 'ENG' }] } }, { json: { results: [{ id: '99', _links: { webui: '/spaces/ENG/pages/99' } }] } }]);
    expect(await client.ensureParentPage('ENG', 'sdlc-agent plans')).toEqual({ id: '99', url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/99' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('/wiki/api/v2/spaces/7/pages?title=sdlc-agent%20plans');
  });

  it('creates the parent page once when it is missing', async () => {
    const { client, calls } = make([{ json: { results: [{ id: '7' }] } }, { json: { results: [] } }, { json: { id: '123', _links: { webui: '/spaces/ENG/pages/123' } } }]);
    expect((await client.ensureParentPage('ENG', 'sdlc-agent plans')).id).toBe('123');
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'https://acme.atlassian.net/wiki/api/v2/pages' });
    expect(calls[2]?.body).toMatchObject({ spaceId: '7', status: 'current', title: 'sdlc-agent plans', body: { representation: 'storage' } });
  });

  it('says so when the space does not exist', async () => {
    const { client } = make([{ json: { results: [] } }]);
    await expect(client.ensureParentPage('NOPE', 'x')).rejects.toThrow('Confluence has no space "NOPE"');
  });

  it('turns an HTTP error into a ConfluenceHttpError with the message Confluence gave', async () => {
    const { client } = make([{ status: 401, json: { message: 'Unauthorized' } }]);
    const err = await client.test().catch((e) => e);
    expect(err).toBeInstanceOf(ConfluenceHttpError);
    expect(err).toMatchObject({ status: 401, message: 'Confluence 401: Unauthorized' });
  });

  it('a network failure is an ordinary error', async () => {
    const { client } = make([new Error('ECONNRESET')]);
    await expect(client.test()).rejects.toThrow('Confluence network error: ECONNRESET');
  });

  it('refuses to be built without credentials', () => {
    expect(() => new ConfluenceRestClient({ baseUrl: '', email: 'a', apiToken: 'b' })).toThrow();
  });
});
