import type { ConfluenceSpace } from '@sdlc/shared';
import { ConfluenceHttpError, ConfluenceVersionConflict, type ConfluenceClient, type ConfluencePage } from './confluence-client';

export interface ConfluenceRestConfig {
  /** The Atlassian site, for example https://acme.atlassian.net (the same credential as Jira). */
  baseUrl: string;
  email: string;
  apiToken: string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Confluence Cloud over plain fetch with Basic auth. Retries are the caller's job (the CONFLUENCE_ERROR policy). */
export class ConfluenceRestClient implements ConfluenceClient {
  private readonly site: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ConfluenceRestConfig, options: { fetch?: typeof fetch } = {}) {
    if (!config.baseUrl || !config.email || !config.apiToken) throw new Error('Confluence needs the Atlassian site URL, email and API token');
    this.site = config.baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  static fromCredentials(c: { jira_base_url: string; jira_email: string; jira_api_token: string }, options?: { fetch?: typeof fetch }): ConfluenceRestClient {
    return new ConfluenceRestClient({ baseUrl: c.jira_base_url, email: c.jira_email, apiToken: c.jira_api_token }, options);
  }

  async test(): Promise<void> {
    await this.request('GET', '/wiki/api/v2/spaces?limit=1');
  }

  /** Global spaces where the person may create pages (the space's `operations` list a create-page permission). */
  async listWritableSpaces(): Promise<ConfluenceSpace[]> {
    const res = await this.request<Json>('GET', '/wiki/rest/api/space?type=global&status=current&limit=100&expand=operations');
    return (res?.results ?? [])
      .filter((s: Json) => (s.operations ?? []).some((o: Json) => o.operation === 'create' && o.targetType === 'page'))
      .map((s: Json) => ({ key: String(s.key), name: String(s.name ?? s.key) }))
      .sort((a: ConfluenceSpace, b: ConfluenceSpace) => a.name.localeCompare(b.name));
  }

  async ensureParentPage(spaceKey: string, title: string): Promise<{ id: string; url: string }> {
    const spaces = await this.request<Json>('GET', `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
    const spaceId = spaces?.results?.[0]?.id;
    if (!spaceId) throw new ConfluenceHttpError(404, `Confluence has no space "${spaceKey}"`);
    const found = await this.request<Json>('GET', `/wiki/api/v2/spaces/${spaceId}/pages?title=${encodeURIComponent(title)}&limit=1`);
    const hit = found?.results?.[0];
    if (hit) return { id: String(hit.id), url: this.pageUrl(hit) };
    const created = await this.request<Json>('POST', '/wiki/api/v2/pages', { spaceId: String(spaceId), status: 'current', title, body: { representation: 'storage', value: '<p>Plans written by sdlc-agent. One page per ticket sits under this one.</p>' } });
    return { id: String(created.id), url: this.pageUrl(created) };
  }

  async createPage(args: { parentId: string; title: string; storage: string }): Promise<ConfluencePage> {
    const parent = await this.request<Json>('GET', `/wiki/api/v2/pages/${encodeURIComponent(args.parentId)}`);
    const created = await this.request<Json>('POST', '/wiki/api/v2/pages', { spaceId: String(parent.spaceId), status: 'current', title: args.title, parentId: args.parentId, body: { representation: 'storage', value: args.storage } });
    return { id: String(created.id), url: this.pageUrl(created), version: Number(created.version?.number ?? 1), title: String(created.title ?? args.title) };
  }

  async getPage(id: string): Promise<ConfluencePage> {
    const page = await this.request<Json>('GET', `/wiki/api/v2/pages/${encodeURIComponent(id)}`);
    return { id: String(page.id), url: this.pageUrl(page), version: Number(page.version?.number ?? 1), title: String(page.title ?? '') };
  }

  async updatePage(args: { id: string; title: string; storage: string; expectedVersion: number }): Promise<{ version: number }> {
    try {
      const res = await this.request<Json>('PUT', `/wiki/api/v2/pages/${encodeURIComponent(args.id)}`, {
        id: args.id,
        status: 'current',
        title: args.title,
        body: { representation: 'storage', value: args.storage },
        version: { number: args.expectedVersion + 1, message: 'Updated by sdlc-agent' },
      });
      return { version: Number(res?.version?.number ?? args.expectedVersion + 1) };
    } catch (err) {
      if (err instanceof ConfluenceHttpError && err.status === 409) throw new ConfluenceVersionConflict(args.id);
      throw err;
    }
  }

  private pageUrl(page: Json): string {
    return `${this.site}/wiki${page._links?.webui ?? `/pages/${page.id}`}`;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.site}${path}`, {
        method,
        headers: { Authorization: this.auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Confluence network error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as Json;
        detail = String(parsed.message ?? parsed.errors?.[0]?.title ?? detail);
      } catch {
        /* not JSON */
      }
      throw new ConfluenceHttpError(res.status, `Confluence ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
  }
}
