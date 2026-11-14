import type { ConfluenceSpace } from '@sdlc/shared';
import { ConfluenceClients } from '../confluence/confluence-clients';
import { ConfluenceVersionConflict, type ConfluenceClient, type ConfluencePage } from '../confluence/confluence-client';

/** A Confluence client that records what it was asked and answers from a script. For tests. */
export class FakeConfluence implements ConfluenceClient {
  spaces: ConfluenceSpace[] = [{ key: 'ENG', name: 'Engineering' }, { key: 'SDA', name: 'SDA Platform' }];
  failWith: Error | null = null;
  calls: string[] = [];
  parents: Record<string, { id: string; url: string }> = {};

  pages: Record<string, { title: string; storage: string; version: number; parentId: string }> = {};
  /** Fail only the page writes (create and update), not the checks used at onboarding. */
  failWrites: Error | null = null;

  /** Someone edits the page by hand: its version moves on. */
  editOutside(id: string, storage = 'edited by hand') {
    const p = this.pages[id];
    if (p) {
      p.version++;
      p.storage = storage;
    }
  }
  private pageView(id: string): ConfluencePage {
    const p = this.pages[id] as NonNullable<(typeof this.pages)[string]>;
    return { id, url: `https://acme.atlassian.net/wiki/spaces/ENG/pages/${id}`, version: p.version, title: p.title };
  }
  async createPage(args: { parentId: string; title: string; storage: string }) {
    this.guard(`create ${args.title}`);
    if (this.failWrites) throw this.failWrites;
    const id = `p${Object.keys(this.pages).length + 100}`;
    this.pages[id] = { title: args.title, storage: args.storage, version: 1, parentId: args.parentId };
    return this.pageView(id);
  }
  async getPage(id: string) {
    this.guard(`get ${id}`);
    return this.pageView(id);
  }
  async updatePage(args: { id: string; title: string; storage: string; expectedVersion: number }) {
    this.guard(`update ${args.id} v${args.expectedVersion}`);
    if (this.failWrites) throw this.failWrites;
    const p = this.pages[args.id];
    if (!p || p.version !== args.expectedVersion) throw new ConfluenceVersionConflict(args.id);
    p.title = args.title;
    p.storage = args.storage;
    p.version++;
    return { version: p.version };
  }
  private guard(call: string) {
    this.calls.push(call);
    if (this.failWith) throw this.failWith;
  }
  async test() {
    this.guard('test');
  }
  async listWritableSpaces() {
    this.guard('spaces');
    return this.spaces;
  }
  async ensureParentPage(spaceKey: string, title: string) {
    this.guard(`parent ${spaceKey} ${title}`);
    return (this.parents[`${spaceKey}/${title}`] ??= { id: `page-${Object.keys(this.parents).length + 1}`, url: `https://acme.atlassian.net/wiki/spaces/${spaceKey}/pages/1` });
  }
}

/** Replaces ConfluenceClients in a test module with a FakeConfluence. */
export class FakeConfluenceClients extends ConfluenceClients {
  constructor(readonly confluence: FakeConfluence = new FakeConfluence()) {
    super({ resolve: async () => ({}) } as never);
  }
  override async forRest() {
    return this.confluence;
  }
}
