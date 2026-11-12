import { JIRA_KEY_PATTERN } from '@sdlc/shared';
import type { JiraClient, JiraIssueStatus, JiraProjectRef, JiraSubtaskInput, JiraTicket } from './jira-client';
import { JiraHttpError } from './jira-client';

/** One issue as the `jiraIntake` stage reports it. */
export interface McpIssue {
  key: string;
  summary: string;
  description: string;
  issuetype: string;
  labels: string[];
  priority: string | null;
  status?: string;
}

export type McpSyncOp =
  | { operation: 'comment'; issueKey: string; text: string }
  | { operation: 'transition'; issueKey: string; targetStatus: string }
  | { operation: 'createSubtask'; issueKey: string; summary: string; text: string; issueTypeName: string };

export interface McpSyncResult {
  applied: boolean;
  detail: string;
  createdKey?: string;
}

/** What `JiraMcpClient` needs from the worker: run the read stage and the write stage. */
export interface JiraMcpPort {
  /** Runs the `jiraIntake` stage with this exact JQL; `projectKey` is the Jira project the results must belong to. */
  read(args: { jql: string; projectKey: string | null; projectId?: string; issueKey?: string }): Promise<McpIssue[]>;
  /** Runs the `jiraSync` stage with one fixed payload. */
  write(op: McpSyncOp): Promise<McpSyncResult>;
}

/**
 * Orchestrator-side checks on tickets the intake stage returned (F3): the key has the Jira shape and belongs to the project. Ticket text is
 * data, never instructions, so it is only stored, never interpreted. A bad ticket rejects the whole answer: the stage is not trusted.
 */
export function validateIssues(issues: readonly McpIssue[], projectKey: string | null): McpIssue[] {
  for (const issue of issues) {
    if (!JIRA_KEY_PATTERN.test(issue.key)) throw new JiraMcpError(`The intake returned an invalid issue key "${issue.key.slice(0, 40)}"`);
    if (projectKey && !issue.key.startsWith(`${projectKey}-`)) throw new JiraMcpError(`The intake returned ${issue.key}, which is not in project ${projectKey}`);
  }
  return [...issues];
}

export class JiraMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraMcpError';
  }
}

const toTicket = ({ status: _status, ...rest }: McpIssue): JiraTicket => rest; // eslint-disable-line @typescript-eslint/no-unused-vars

/** `JiraClient` over the Jira MCP server: reads through the `jiraIntake` stage, writes through `jiraSync` (BUILD_PLAN 8). */
export class JiraMcpClient implements JiraClient {
  constructor(private readonly port: JiraMcpPort) {}

  async searchTickets(project: JiraProjectRef): Promise<JiraTicket[]> {
    const jql = project.jiraJql?.trim();
    if (!jql) throw new JiraMcpError('The project has no JQL');
    const issues = validateIssues(await this.port.read({ jql, projectKey: project.jiraProjectKey ?? null, projectId: project.id }), project.jiraProjectKey ?? null);
    return issues.map(toTicket);
  }

  async readStatus(key: string): Promise<JiraIssueStatus> {
    if (!JIRA_KEY_PATTERN.test(key)) throw new JiraMcpError(`"${key}" is not a Jira issue key`);
    const [issue] = validateIssues(await this.port.read({ jql: `key = ${key}`, projectKey: key.slice(0, key.lastIndexOf('-')), issueKey: key }), key.slice(0, key.lastIndexOf('-')));
    if (!issue || issue.key !== key) throw new JiraHttpError(404, `Jira issue ${key} was not found`);
    if (!issue.status) throw new JiraMcpError(`The intake did not report the status of ${key}`);
    return { key, status: issue.status, summary: issue.summary, description: issue.description };
  }

  private async write(op: McpSyncOp): Promise<McpSyncResult> {
    if (!JIRA_KEY_PATTERN.test(op.issueKey)) throw new JiraMcpError(`"${op.issueKey}" is not a Jira issue key`);
    const result = await this.port.write(op);
    if (!result.applied) throw new JiraMcpError(`Jira did not apply the ${op.operation}: ${result.detail}`.slice(0, 300));
    return result;
  }

  async comment(key: string, markdown: string): Promise<void> {
    await this.write({ operation: 'comment', issueKey: key, text: markdown });
  }

  async transition(key: string, statusName: string): Promise<void> {
    await this.write({ operation: 'transition', issueKey: key, targetStatus: statusName });
  }

  async createSubtask(parentKey: string, subtask: JiraSubtaskInput): Promise<{ key: string }> {
    const result = await this.write({ operation: 'createSubtask', issueKey: parentKey, summary: subtask.summary, text: subtask.description, issueTypeName: subtask.issueTypeName ?? 'Sub-task' });
    if (!result.createdKey || !JIRA_KEY_PATTERN.test(result.createdKey)) throw new JiraMcpError('Jira did not report the key of the new sub-task');
    return { key: result.createdKey };
  }

  async listStatuses(): Promise<string[]> {
    throw new JiraMcpError('Listing statuses is only available in REST mode');
  }
}
