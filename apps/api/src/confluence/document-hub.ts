import { markdownToStorage } from '@sdlc/shared';
import { ConfluenceVersionConflict, type ConfluenceClient } from './confluence-client';

/** What a document hub is given: a title, markdown, and the status line shown at the top (BUILD_PLAN v1 6.10). */
export interface HubDocument {
  title: string;
  markdown: string;
  status: string;
}

export interface PublishedPage {
  url: string;
  id: string;
  version: number;
}

/** Where plans are published. Confluence is the only implementation in v1. */
export interface DocumentHub {
  publish(args: { parentId: string; doc: HubDocument }): Promise<PublishedPage>;
  /** Sends the version the caller knows; when someone edited the page meanwhile, applies on top of the latest version after a note. */
  update(id: string, expectedVersion: number, doc: HubDocument): Promise<{ version: number; conflicted: boolean }>;
  test(): Promise<void>;
}

const body = (doc: HubDocument, note = '') => `${note}<p><strong>${doc.status.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</strong></p>${markdownToStorage(doc.markdown)}`;
const EDITED = '<p><em>Edited outside sdlc-agent: the text below replaces the edited version. Confluence keeps the history.</em></p>';

export class ConfluenceHub implements DocumentHub {
  constructor(private readonly client: ConfluenceClient) {}

  async publish({ parentId, doc }: { parentId: string; doc: HubDocument }): Promise<PublishedPage> {
    const page = await this.client.createPage({ parentId, title: doc.title, storage: body(doc) });
    return { url: page.url, id: page.id, version: page.version };
  }

  async update(id: string, expectedVersion: number, doc: HubDocument): Promise<{ version: number; conflicted: boolean }> {
    try {
      const r = await this.client.updatePage({ id, title: doc.title, storage: body(doc), expectedVersion });
      return { version: r.version, conflicted: false };
    } catch (err) {
      if (!(err instanceof ConfluenceVersionConflict)) throw err;
      const latest = await this.client.getPage(id);
      const r = await this.client.updatePage({ id, title: doc.title, storage: body(doc, EDITED), expectedVersion: latest.version });
      return { version: r.version, conflicted: true };
    }
  }

  test(): Promise<void> {
    return this.client.test();
  }
}
