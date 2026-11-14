import { describe, expect, it } from 'vitest';
import { JiraHttpError, JiraStatusNotFoundError, JiraUnavailableError, jiraMarker, markerLabel } from './jira-client';
import { JiraRestClient } from './jira-rest-client';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; text?: string } | Error;

/** A scripted fetch: replies are consumed in order (the last one repeats), and every call is recorded. */
function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : (reply.text ?? JSON.stringify(reply.json ?? {})), { status, headers: reply.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const make = (replies: Reply[], extra: { pageSize?: number } = {}) => {
  const { impl, calls } = mockFetch(replies);
  const sleeps: number[] = [];
  const client = new JiraRestClient({ baseUrl: 'https://acme.atlassian.net/', email: 'me@acme.com', apiToken: 'tok' }, { fetch: impl, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { client, calls, sleeps };
};

const issue = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: `Summary ${key}`, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Body ${key}` }] }] }, issuetype: { name: 'Story' }, labels: ['a'], priority: { name: 'High' }, ...over },
});

describe('JiraRestClient requests (BUILD_PLAN 6.3)', () => {
  it('uses Basic auth on the configured base URL', async () => {
    const { client, calls } = make([{ json: { issues: [] } }]);
    await client.searchTickets({ jiraJql: 'project = ABC' });
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.com:tok').toString('base64')}`);
    expect(calls[0]?.headers.Accept).toBe('application/json');
  });

  it('refuses to be built without credentials', () => {
    expect(() => new JiraRestClient({ baseUrl: '', email: 'a', apiToken: 'b' })).toThrow(/JIRA_BASE_URL/);
    expect(() => JiraRestClient.fromCredentials({ jira_base_url: '', jira_email: '', jira_api_token: '' })).toThrow();
  });
});

describe('searchTickets', () => {
  it('posts the JQL with only the needed fields, and converts ADF descriptions', async () => {
    const { client, calls } = make([{ json: { issues: [issue('ABC-1')], isLast: true } }]);
    const tickets = await client.searchTickets({ jiraJql: 'project = ABC AND status = "To Do"' });
    expect(calls[0]?.body).toEqual({ jql: 'project = ABC AND status = "To Do"', fields: ['summary', 'description', 'issuetype', 'labels', 'priority', 'parent'], maxResults: 50 });
    expect(tickets).toEqual([{ key: 'ABC-1', summary: 'Summary ABC-1', description: 'Body ABC-1', issuetype: 'Story', labels: ['a'], priority: 'High', isSubtask: false }]);
  });

  it('marks sub-tasks: by the issue type flag, or by having a parent', async () => {
    const sub = { key: 'ABC-2', fields: { summary: 'S', issuetype: { name: 'Sub-task', subtask: true } } };
    const child = { key: 'ABC-3', fields: { summary: 'S', issuetype: { name: 'Task' }, parent: { key: 'ABC-1' } } };
    const tickets = await make([{ json: { issues: [sub, child, issue('ABC-1')], isLast: true } }]).client.searchTickets({ jiraJql: 'x' });
    expect(tickets.map((t) => [t.key, t.isSubtask])).toEqual([['ABC-2', true], ['ABC-3', true], ['ABC-1', false]]);
  });

  it('follows nextPageToken until the last page', async () => {
    const { client, calls } = make([
      { json: { issues: [issue('ABC-1'), issue('ABC-2')], nextPageToken: 'p2' } },
      { json: { issues: [issue('ABC-3')], nextPageToken: 'p3' } },
      { json: { issues: [issue('ABC-4')], isLast: true } },
    ]);
    const tickets = await client.searchTickets({ jiraJql: 'x' });
    expect(tickets.map((t) => t.key)).toEqual(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4']);
    expect(calls.map((c) => c.body.nextPageToken)).toEqual([undefined, 'p2', 'p3']);
  });

  it('handles an empty result, missing fields and a null description', async () => {
    expect(await make([{ json: { issues: [] } }]).client.searchTickets({ jiraJql: 'x' })).toEqual([]);
    expect(await make([{ json: {} }]).client.searchTickets({ jiraJql: 'x' })).toEqual([]);
    const sparse = await make([{ json: { issues: [{ key: 'ABC-9', fields: { summary: 'S', description: null } }] } }]).client.searchTickets({ jiraJql: 'x' });
    expect(sparse[0]).toEqual({ key: 'ABC-9', summary: 'S', description: '', issuetype: '', labels: [], priority: null, isSubtask: false });
  });

  it('falls back to the project key, and returns nothing without JQL or key', async () => {
    const { client, calls } = make([{ json: { issues: [] } }, { json: { issues: [] } }]);
    await client.searchTickets({ jiraProjectKey: 'ABC', jiraJql: '  ' });
    expect(calls[0]?.body.jql).toBe('project = "ABC" AND labels = "sdlc-agent" ORDER BY created ASC'); // the default query: only issues labelled sdlc-agent
    await client.searchTickets({ jiraProjectKey: 'ABC', jiraJql: 'project = ABC AND status = "Ready"' });
    expect(calls[1]?.body.jql).toBe('project = ABC AND status = "Ready"'); // a query set on the project is used exactly as written
    const none = make([{ json: {} }]);
    expect(await none.client.searchTickets({})).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });

  it('stops after the page cap even if Jira keeps returning a token', async () => {
    const { impl, calls } = mockFetch([{ json: { issues: [issue('ABC-1')], nextPageToken: 'again' } }]);
    const capped = new JiraRestClient({ baseUrl: 'https://x', email: 'a', apiToken: 'b' }, { fetch: impl, maxPages: 3, sleep: async () => undefined });
    expect(await capped.searchTickets({ jiraJql: 'x' })).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });
});

describe('readStatus, comment, createSubtask, listStatuses', () => {
  it('reads one issue with only the needed fields', async () => {
    const { client, calls } = make([{ json: issue('ABC-1', { status: { name: 'In Review' } }) }]);
    expect(await client.readStatus('ABC-1')).toEqual({ key: 'ABC-1', status: 'In Review', summary: 'Summary ABC-1', description: 'Body ABC-1' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://acme.atlassian.net/rest/api/3/issue/ABC-1?fields=status,summary,description' });
  });

  it('posts a comment with an ADF body', async () => {
    const { client, calls } = make([{ status: 201, json: { id: '1' } }]);
    await client.comment('ABC-1', '## Plan\n\n- do it');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://acme.atlassian.net/rest/api/3/issue/ABC-1/comment' });
    expect(calls[0]?.body.body).toMatchObject({ type: 'doc', version: 1 });
    expect(calls[0]?.body.body.content[0]).toMatchObject({ type: 'heading' });
  });

  it('skips a comment whose marker is already on the issue, and posts it otherwise (safe to repeat)', async () => {
    const marker = jiraMarker('SDA-1', 'plan', 'the plan');
    const seen = make([{ json: { comments: [{ id: '1', body: { type: 'doc', content: [{ type: 'text', text: `old\n\n${marker}` }] } }] } }]);
    await seen.client.comment('ABC-1', 'plan text', marker);
    expect(seen.calls).toHaveLength(1); // only the lookup
    const fresh = make([{ json: { comments: [] } }, { status: 201, json: { id: '2' } }]);
    await fresh.client.comment('ABC-1', 'plan text', marker);
    expect(fresh.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(JSON.stringify(fresh.calls[1]?.body)).toContain(marker);
    expect(jiraMarker('SDA-1', 'plan', 'the plan')).toBe(marker);
    expect(jiraMarker('SDA-1', 'plan', 'other plan')).not.toBe(marker);
  });

  it('finds an earlier sub-task by its marker label instead of creating another', async () => {
    const marker = jiraMarker('ABC-5', 'subtask-1', 'Add parser');
    const found = make([{ json: { issues: [{ key: 'ABC-12' }] } }]);
    expect(await found.client.createSubtask('ABC-5', { summary: 'Add parser', description: '', marker })).toEqual({ key: 'ABC-12' });
    expect(found.calls).toHaveLength(1);
    const none = make([{ json: { issues: [] } }, { status: 201, json: { key: 'ABC-13' } }]);
    expect(await none.client.createSubtask('ABC-5', { summary: 'Add parser', description: '', marker })).toEqual({ key: 'ABC-13' });
    expect(none.calls[1]?.body.fields.labels).toEqual([markerLabel(marker)]);
  });

  it('creates a sub-task under the parent, in the parent project, with the configured type', async () => {
    const { client, calls } = make([{ status: 201, json: { key: 'ABC-12' } }]);
    expect(await client.createSubtask('ABC-5', { summary: 'Add parser', description: 'Parse it', issueTypeName: 'Subtask' })).toEqual({ key: 'ABC-12' });
    expect(calls[0]?.body.fields).toMatchObject({ project: { key: 'ABC' }, parent: { key: 'ABC-5' }, summary: 'Add parser', issuetype: { name: 'Subtask' } });
    expect(calls[0]?.body.fields.description.type).toBe('doc');
    const dflt = make([{ status: 201, json: { key: 'AB1-2' } }]);
    await dflt.client.createSubtask('AB1-1', { summary: 's', description: '' });
    expect(dflt.calls[0]?.body.fields.issuetype.name).toBe('Sub-task');
    expect(dflt.calls[0]?.body.fields.project.key).toBe('AB1');
  });

  it('lists distinct status names across issue types, sorted', async () => {
    const { client, calls } = make([{ json: [{ name: 'Story', statuses: [{ name: 'To Do' }, { name: 'Done' }] }, { name: 'Bug', statuses: [{ name: 'In Progress' }, { name: 'Done' }] }] }]);
    expect(await client.listStatuses('ABC')).toEqual(['Done', 'In Progress', 'To Do']);
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/3/project/ABC/statuses');
  });
});

describe('transition', () => {
  const toDo = { json: { fields: { status: { name: 'To Do' } } } };
  const transitions = { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] };

  it('finds the transition by target status name, case-insensitively, and performs it', async () => {
    const { client, calls } = make([toDo, { json: transitions }, { status: 204 }]);
    await client.transition('ABC-1', '  in progress ');
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({ method: 'GET', url: 'https://acme.atlassian.net/rest/api/3/issue/ABC-1/transitions' });
    expect(calls[2]).toMatchObject({ method: 'POST', body: { transition: { id: '11' } } });
  });

  it('is a no-op when the issue is already in that status (safe to repeat)', async () => {
    const { client, calls } = make([{ json: { fields: { status: { name: 'In Progress' } } } }]);
    await client.transition('ABC-1', 'in progress');
    expect(calls).toHaveLength(1); // only the status read
  });

  it('throws JiraStatusNotFoundError listing what is available when the status does not exist', async () => {
    const { client, calls } = make([toDo, { json: transitions }]);
    const err = await client.transition('ABC-1', 'Shipped').catch((e) => e);
    expect(err).toBeInstanceOf(JiraStatusNotFoundError);
    expect(err.message).toBe('Jira has no transition to "Shipped" for ABC-1 (available: In Progress, Done)');
    expect(err.available).toEqual(['In Progress', 'Done']);
    expect(calls).toHaveLength(2); // nothing was posted
  });

  it('copes with an issue that has no transitions at all', async () => {
    const err = await make([toDo, { json: {} }]).client.transition('ABC-1', 'Done').catch((e) => e);
    expect(err).toBeInstanceOf(JiraStatusNotFoundError);
    expect(err.available).toEqual([]);
  });
});

describe('retries (BUILD_PLAN 6.3)', () => {
  it('retries 5xx with 1 s, 4 s, 16 s backoff and then succeeds', async () => {
    const { client, calls, sleeps } = make([{ status: 503 }, { status: 500 }, { status: 502 }, { json: { issues: [issue('ABC-1')] } }]);
    expect((await client.searchTickets({ jiraJql: 'x' })).map((t) => t.key)).toEqual(['ABC-1']);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 4000, 16000]);
  });

  it('retries network errors too', async () => {
    const { client, sleeps } = make([new Error('ECONNRESET'), { json: { issues: [] } }]);
    expect(await client.searchTickets({ jiraJql: 'x' })).toEqual([]);
    expect(sleeps).toEqual([1000]);
  });

  it('honours Retry-After on 429, in seconds or as a date, capped at a minute', async () => {
    const seconds = make([{ status: 429, headers: { 'Retry-After': '7' } }, { json: { issues: [] } }]);
    await seconds.client.searchTickets({ jiraJql: 'x' });
    expect(seconds.sleeps).toEqual([7000]);
    const huge = make([{ status: 429, headers: { 'Retry-After': '99999' } }, { json: { issues: [] } }]);
    await huge.client.searchTickets({ jiraJql: 'x' });
    expect(huge.sleeps).toEqual([60_000]);
    const date = make([{ status: 429, headers: { 'Retry-After': new Date(Date.now() + 5000).toUTCString() } }, { json: { issues: [] } }]);
    await date.client.searchTickets({ jiraJql: 'x' });
    expect(date.sleeps[0]).toBeGreaterThan(2000);
    expect(date.sleeps[0]).toBeLessThanOrEqual(5000);
    const none = make([{ status: 429 }, { json: { issues: [] } }]);
    await none.client.searchTickets({ jiraJql: 'x' });
    expect(none.sleeps).toEqual([1000]); // no header: normal backoff
  });

  it('throws JiraUnavailableError when the retries run out (the caller pauses intake)', async () => {
    const { client, calls, sleeps } = make([{ status: 503 }]);
    const err = await client.searchTickets({ jiraJql: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(JiraUnavailableError);
    expect(err.attempts).toBe(4);
    expect(err.message).toContain('HTTP 503');
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 4000, 16000]);
  });

  it('does not retry client errors, and reports Jira’s message', async () => {
    const { client, calls, sleeps } = make([{ status: 400, json: { errorMessages: ['Unbounded JQL queries are not allowed here.'], errors: { jql: 'bad' } } }]);
    const err = await client.searchTickets({ jiraJql: 'order by created' }).catch((e) => e);
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Jira 400: Unbounded JQL queries are not allowed here.; bad');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    for (const status of [401, 403, 404]) expect((await make([{ status, text: 'nope' }]).client.readStatus('A-1').catch((e) => e)).status).toBe(status);
  });
});


describe('projectFacts (onboarding)', () => {
  const project = { name: 'Billing', issueTypes: [{ name: 'Story', subtask: false }, { name: 'Epic', subtask: false }, { name: 'Sub-task', subtask: true }] };
  const statuses = [
    { name: 'Story', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, { name: 'Done', statusCategory: { key: 'done' } }] },
    { name: 'Epic', statuses: [{ name: 'Open', statusCategory: { key: 'new' } }] },
  ];

  it('collects the project, its issue types, statuses per type and the labels in use', async () => {
    const { client, calls } = make([{ json: project }, { json: statuses }, { json: { issues: [{ fields: { labels: ['backend', 'sdlc-agent'] } }, { fields: { labels: ['backend'] } }, { fields: {} }] } }]);
    const facts = await client.projectFacts('SDA');
    expect(facts.projectName).toBe('Billing');
    expect(facts.issueTypes).toEqual([{ name: 'Story', subtask: false }, { name: 'Epic', subtask: false }, { name: 'Sub-task', subtask: true }]);
    expect(facts.statusesByType[0]).toEqual({ type: 'Story', statuses: [{ name: 'To Do', category: 'new' }, { name: 'In Progress', category: 'indeterminate' }, { name: 'Done', category: 'done' }] });
    expect(facts.labels).toEqual(['backend', 'sdlc-agent']);
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://acme.atlassian.net', '')}`)).toEqual(['GET /rest/api/3/project/SDA', 'GET /rest/api/3/project/SDA/statuses', 'POST /rest/api/3/search/jql']);
    // Jira has no per-project label endpoint: labels come from a search that asks only for them.
    expect(calls[2]?.body).toMatchObject({ jql: 'project = "SDA" ORDER BY created DESC', fields: ['labels'] });
  });

  it('a project key Jira does not know is an error, not an empty answer', async () => {
    const { client } = make([{ status: 404, json: { errorMessages: ['No project could be found with key NOPE.'] } }]);
    await expect(client.projectFacts('NOPE')).rejects.toThrow(/No project could be found/);
  });
});
