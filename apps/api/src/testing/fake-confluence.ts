import type { ConfluenceSpace } from '@sdlc/shared';
import { ConfluenceClients } from '../confluence/confluence-clients';
import type { ConfluenceClient } from '../confluence/confluence-client';

/** A Confluence client that records what it was asked and answers from a script. For tests. */
export class FakeConfluence implements ConfluenceClient {
  spaces: ConfluenceSpace[] = [{ key: 'ENG', name: 'Engineering' }, { key: 'SDA', name: 'SDA Platform' }];
  failWith: Error | null = null;
  calls: string[] = [];
  parents: Record<string, { id: string; url: string }> = {};

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
