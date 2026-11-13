import { createHash } from 'node:crypto';

/** What the pipeline needs from Jira (BUILD_PLAN 8 Worker interfaces). Two implementations: REST (default) and MCP. */

export interface JiraTicket {
  key: string;
  summary: string;
  /** Description converted to markdown-ish text. */
  description: string;
  issuetype: string;
  labels: string[];
  priority: string | null;
  /** True when Jira says the issue type is a sub-task, or the issue has a parent (REST only; MCP gives the type name). */
  isSubtask?: boolean;
}

export interface JiraIssueStatus {
  key: string;
  status: string;
  summary: string;
  description: string;
}

export interface JiraSubtaskInput {
  /** Stored as a label; a second call with the same marker finds the first sub-task instead of creating another. */
  marker?: string;
  summary: string;
  /** Markdown. */
  description: string;
  /** Defaults to `Sub-task`; comes from `jiraSubtaskTypeName`. */
  issueTypeName?: string;
}

export interface JiraProjectRef {
  /** Our project id (MCP mode records its stage runs against it). */
  id?: string;
  jiraProjectKey?: string | null;
  jiraJql?: string | null;
}

export interface JiraClient {
  searchTickets(project: JiraProjectRef): Promise<JiraTicket[]>;
  readStatus(key: string): Promise<JiraIssueStatus>;
  /** With a `marker` the call is safe to repeat: when the issue already has a comment carrying it, nothing is posted. */
  comment(key: string, markdown: string, marker?: string): Promise<void>;
  /** Moves the issue to the status with this name (case-insensitive). Throws JiraStatusNotFoundError if there is none. */
  transition(key: string, statusName: string): Promise<void>;
  createSubtask(parentKey: string, subtask: JiraSubtaskInput): Promise<{ key: string }>;
  listStatuses(projectKey: string): Promise<string[]>;
}

/**
 * The hidden marker that makes a Jira write safe to repeat (BUILD_PLAN v1 6.3): `[sdlc-agent:{ticket}:{purpose}:{version}]`.
 * The version is a short hash of the content, so changed content is posted again and identical content is not.
 */
export function jiraMarker(ticketKey: string, purpose: string, content = ''): string {
  const version = createHash('sha1').update(content).digest('hex').slice(0, 8);
  return `[sdlc-agent:${ticketKey}:${purpose}:${version}]`;
}

/** The same marker as a Jira label (labels cannot hold brackets or colons). */
export const markerLabel = (marker: string): string => marker.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 255);

/** A non-retryable HTTP error from Jira (400, 401, 403, 404, ...). */
export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraHttpError';
  }
}

/** Retries ran out (network errors, 429, 5xx). Intake pauses for 10 minutes; the pipeline does not (BUILD_PLAN 6.3). */
export class JiraUnavailableError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'JiraUnavailableError';
  }
}

/** The mapped status does not exist or cannot be reached from the issue's current status. */
export class JiraStatusNotFoundError extends Error {
  constructor(
    readonly key: string,
    readonly wanted: string,
    readonly available: string[],
  ) {
    super(`Jira has no transition to "${wanted}" for ${key} (available: ${available.length > 0 ? available.join(', ') : 'none'})`);
    this.name = 'JiraStatusNotFoundError';
  }
}
