import type { ConfluenceSpace } from '@sdlc/shared';

/** What the pipeline needs from Confluence (BUILD_PLAN v1 6.10). Cloud only; the page operations arrive with the document hub. */
export interface ConfluenceClient {
  /** The spaces the person can create pages in. */
  listWritableSpaces(): Promise<ConfluenceSpace[]>;
  /** The page every plan goes under, found by title or created (once). */
  ensureParentPage(spaceKey: string, title: string): Promise<{ id: string; url: string }>;
  /** Creates a page under a parent. `storage` is Confluence storage format. */
  createPage(args: { parentId: string; title: string; storage: string }): Promise<ConfluencePage>;
  getPage(id: string): Promise<ConfluencePage>;
  /** Updates a page; `expectedVersion` is the version the caller last saw. Throws ConfluenceVersionConflict when the page moved on. */
  updatePage(args: { id: string; title: string; storage: string; expectedVersion: number }): Promise<{ version: number }>;
  /** Cheap proof that the credential reaches Confluence. */
  test(): Promise<void>;
}

export interface ConfluencePage {
  id: string;
  url: string;
  version: number;
  title: string;
}

/** Someone else changed the page since the version we sent. */
export class ConfluenceVersionConflict extends Error {
  constructor(readonly id: string) {
    super(`Confluence page ${id} was changed since the version we know`);
    this.name = 'ConfluenceVersionConflict';
  }
}

/** A non-retryable HTTP error from Confluence (400, 401, 403, 404, ...). */
export class ConfluenceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConfluenceHttpError';
  }
}

/** The credentials do not reach Confluence, or are missing. The project then works without it (BUILD_PLAN v1 D6). */
export class ConfluenceNotConfiguredError extends Error {
  constructor() {
    super('Confluence is not configured: add the Atlassian site URL, email and API token in Settings → Connections');
    this.name = 'ConfluenceNotConfiguredError';
  }
}
