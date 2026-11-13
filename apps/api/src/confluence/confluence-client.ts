import type { ConfluenceSpace } from '@sdlc/shared';

/** What the pipeline needs from Confluence (BUILD_PLAN v1 6.10). Cloud only; the page operations arrive with the document hub. */
export interface ConfluenceClient {
  /** The spaces the person can create pages in. */
  listWritableSpaces(): Promise<ConfluenceSpace[]>;
  /** The page every plan goes under, found by title or created (once). */
  ensureParentPage(spaceKey: string, title: string): Promise<{ id: string; url: string }>;
  /** Cheap proof that the credential reaches Confluence. */
  test(): Promise<void>;
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
