/** What the pipeline needs from Jira (BUILD_PLAN 8 Worker interfaces). Two implementations: REST (default) and MCP. */

export interface JiraTicket {
  key: string;
  summary: string;
  /** Description converted to markdown-ish text. */
  description: string;
  issuetype: string;
  labels: string[];
  priority: string | null;
}

export interface JiraIssueStatus {
  key: string;
  status: string;
  summary: string;
  description: string;
}

export interface JiraSubtaskInput {
  summary: string;
  /** Markdown. */
  description: string;
  /** Defaults to `Sub-task`; comes from `jiraSubtaskTypeName`. */
  issueTypeName?: string;
}

export interface JiraProjectRef {
  jiraProjectKey?: string | null;
  jiraJql?: string | null;
}

export interface JiraClient {
  searchTickets(project: JiraProjectRef): Promise<JiraTicket[]>;
  readStatus(key: string): Promise<JiraIssueStatus>;
  comment(key: string, markdown: string): Promise<void>;
  /** Moves the issue to the status with this name (case-insensitive). Throws JiraStatusNotFoundError if there is none. */
  transition(key: string, statusName: string): Promise<void>;
  createSubtask(parentKey: string, subtask: JiraSubtaskInput): Promise<{ key: string }>;
  listStatuses(projectKey: string): Promise<string[]>;
}

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
