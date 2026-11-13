import { defaultJiraJql, type JiraFacts } from '@sdlc/shared';
import { adfToText, markdownToAdf } from './adf';
import {
  markerLabel, JiraHttpError, JiraStatusNotFoundError, JiraUnavailableError,
  type JiraClient, type JiraIssueStatus, type JiraProjectRef, type JiraSubtaskInput, type JiraTicket,
} from './jira-client';

export interface JiraRestConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraRestOptions {
  fetch?: typeof fetch;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff between retries: 1 s, 4 s, 16 s (BUILD_PLAN 6.3). */
  backoffMs?: readonly number[];
  /** Search page size. */
  pageSize?: number;
  /** Safety cap on pages per search. */
  maxPages?: number;
}

const DEFAULT_BACKOFF = [1000, 4000, 16000] as const;
const MAX_RETRY_AFTER_MS = 60_000;
const SEARCH_FIELDS = ['summary', 'description', 'issuetype', 'labels', 'priority', 'parent'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Jira Cloud REST API v3 over plain fetch, with Basic auth (BUILD_PLAN 6.3). */
export class JiraRestClient implements JiraClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: readonly number[];
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(config: JiraRestConfig, options: JiraRestOptions = {}) {
    if (!config.baseUrl || !config.email || !config.apiToken) throw new Error('Jira REST needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN');
    this.base = config.baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF;
    this.pageSize = options.pageSize ?? 50;
    this.maxPages = options.maxPages ?? 40;
  }

  static fromCredentials(c: { jira_base_url: string; jira_email: string; jira_api_token: string }, options?: JiraRestOptions): JiraRestClient {
    return new JiraRestClient({ baseUrl: c.jira_base_url, email: c.jira_email, apiToken: c.jira_api_token }, options);
  }

  // ---------------------------------------------------------------- JiraClient

  async searchTickets(project: JiraProjectRef): Promise<JiraTicket[]> {
    // An empty JQL means the default: the project's issues labelled `sdlc-agent`. A JQL set on the project is used exactly as written.
    const jql = project.jiraJql?.trim() || defaultJiraJql(project.jiraProjectKey);
    if (!jql) return [];
    const tickets: JiraTicket[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const body: Json = { jql, fields: SEARCH_FIELDS, maxResults: this.pageSize };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const res = await this.request<Json>('POST', '/rest/api/3/search/jql', body);
      for (const issue of res.issues ?? []) tickets.push(this.toTicket(issue));
      nextPageToken = res.nextPageToken;
      if (!nextPageToken || res.isLast === true) break;
    }
    return tickets;
  }

  async readStatus(key: string): Promise<JiraIssueStatus> {
    const issue = await this.request<Json>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,summary,description`);
    return {
      key: issue.key ?? key,
      status: issue.fields?.status?.name ?? '',
      summary: issue.fields?.summary ?? '',
      description: adfToText(issue.fields?.description),
    };
  }

  async comment(key: string, markdown: string, marker?: string): Promise<void> {
    if (marker) {
      const existing = await this.request<Json>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=1000`);
      if (JSON.stringify(existing.comments ?? []).includes(marker)) return;
    }
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: markdownToAdf(marker ? `${markdown}\n\n${marker}` : markdown) });
  }

  async transition(key: string, statusName: string): Promise<void> {
    // Read the current status first: moving an issue to the status it is in is a repeat, not a change.
    const current = await this.request<Json>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`);
    if (String(current.fields?.status?.name ?? '').trim().toLowerCase() === statusName.trim().toLowerCase()) return;
    const res = await this.request<Json>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const transitions: Json[] = res.transitions ?? [];
    const wanted = statusName.trim().toLowerCase();
    const match = transitions.find((t) => String(t.to?.name ?? '').trim().toLowerCase() === wanted);
    if (!match) throw new JiraStatusNotFoundError(key, statusName, transitions.map((t) => String(t.to?.name ?? t.name ?? '')).filter(Boolean));
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
  }

  async createSubtask(parentKey: string, subtask: JiraSubtaskInput): Promise<{ key: string }> {
    const projectKey = parentKey.slice(0, parentKey.lastIndexOf('-'));
    const label = subtask.marker ? markerLabel(subtask.marker) : null;
    if (label) {
      // An earlier attempt may have created it and failed before we stored the key: look for the marker label first.
      const found = await this.request<Json>('POST', '/rest/api/3/search/jql', { jql: `parent = "${parentKey}" AND labels = "${label}"`, fields: ['summary'], maxResults: 1 });
      const hit = (found.issues ?? [])[0];
      if (hit?.key) return { key: String(hit.key) };
    }
    const created = await this.request<Json>('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: projectKey },
        parent: { key: parentKey },
        summary: subtask.summary,
        description: markdownToAdf(subtask.description),
        issuetype: { name: subtask.issueTypeName ?? 'Sub-task' },
        ...(label ? { labels: [label] } : {}),
      },
    });
    return { key: String(created.key) };
  }

  /** Distinct status names across the project's issue types, sorted (for the mapping dropdown). */
  async listStatuses(projectKey: string): Promise<string[]> {
    const types = await this.request<Json[]>('GET', `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
    const names = new Set<string>();
    for (const type of types) for (const status of type.statuses ?? []) if (status.name) names.add(String(status.name));
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /**
   * GET /project/{key}: name, issue types and which one is the sub-task type. GET /project/{key}/statuses: statuses per issue type
   * with their category. Labels in use come from a search over recent issues, because Jira has no per-project label endpoint.
   */
  async projectFacts(projectKey: string): Promise<JiraFacts> {
    const key = encodeURIComponent(projectKey);
    const project = await this.request<Json>('GET', `/rest/api/3/project/${key}`);
    const statuses = await this.request<Json[]>('GET', `/rest/api/3/project/${key}/statuses`);
    const recent = await this.request<Json>('POST', '/rest/api/3/search/jql', { jql: `project = "${projectKey.replace(/"/g, '')}" ORDER BY created DESC`, fields: ['labels'], maxResults: 100 });
    const labels = new Set<string>();
    for (const issue of recent?.issues ?? []) for (const l of issue.fields?.labels ?? []) labels.add(String(l));
    return {
      projectName: String(project.name ?? projectKey),
      issueTypes: (project.issueTypes ?? []).map((t: Json) => ({ name: String(t.name), subtask: t.subtask === true })),
      statusesByType: (statuses ?? []).map((t: Json) => ({
        type: String(t.name),
        statuses: (t.statuses ?? []).map((s: Json) => ({ name: String(s.name), category: String(s.statusCategory?.key ?? 'unknown') })),
      })),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
    };
  }

  // ---------------------------------------------------------------- internals

  private toTicket(issue: Json): JiraTicket {
    const f = issue.fields ?? {};
    return {
      key: String(issue.key),
      summary: String(f.summary ?? ''),
      description: adfToText(f.description),
      issuetype: String(f.issuetype?.name ?? ''),
      labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
      priority: f.priority?.name ? String(f.priority.name) : null,
      isSubtask: f.issuetype?.subtask === true || Boolean(f.parent),
    };
  }

  /** One request with retries: network errors, 429 (honouring Retry-After) and 5xx are retried with backoff. */
  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const attempts = this.backoff.length + 1;
    let lastProblem = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers: { Authorization: this.auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        lastProblem = `network error: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (res) {
        if (res.ok) return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
        if (res.status !== 429 && res.status < 500) throw new JiraHttpError(res.status, await this.errorMessage(res));
        lastProblem = `HTTP ${res.status}`;
      }

      if (attempt < attempts - 1) {
        const retryAfter = res?.status === 429 ? this.retryAfterMs(res) : null;
        await this.sleep(retryAfter ?? (this.backoff[attempt] as number));
      }
    }
    throw new JiraUnavailableError(`Jira is unavailable after ${attempts} attempts (${lastProblem})`, attempts);
  }

  private retryAfterMs(res: Response): number | null {
    const header = res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
  }

  private async errorMessage(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(text) as Json;
      const messages = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].map(String).filter(Boolean);
      if (messages.length > 0) return `Jira ${res.status}: ${messages.join('; ')}`;
    } catch {
      /* not JSON */
    }
    return `Jira ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
  }
}
