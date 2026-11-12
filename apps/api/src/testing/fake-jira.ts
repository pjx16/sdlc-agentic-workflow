import type { JiraClient, JiraIssueStatus, JiraProjectRef, JiraSubtaskInput, JiraTicket } from '../jira/jira-client';
import { JiraStatusNotFoundError } from '../jira/jira-client';
import { JiraClients } from '../jira/jira-clients';

/** A Jira client that records what it was asked to do and answers from a script. For tests. */
export class FakeJira implements JiraClient {
  tickets: JiraTicket[] = [];
  statuses: Record<string, string> = {}; // issue key -> current status
  projectStatuses: string[] = ['To Do', 'In Progress', 'Done'];
  existingTargets = new Set(['to do', 'in progress', 'done', 'in review']); // statuses a transition can reach
  failWith: Error | null = null;
  calls: string[] = [];
  searches: JiraProjectRef[] = [];

  private guard(call: string) {
    this.calls.push(call);
    if (this.failWith) throw this.failWith;
  }
  async searchTickets(project: JiraProjectRef) {
    this.guard('search');
    this.searches.push(project);
    return this.tickets;
  }
  async readStatus(key: string): Promise<JiraIssueStatus> {
    this.guard(`read ${key}`);
    return { key, status: this.statuses[key] ?? 'To Do', summary: '', description: '' };
  }
  async comment(key: string) {
    this.guard(`comment ${key}`);
  }
  async transition(key: string, statusName: string) {
    this.guard(`transition ${key} -> ${statusName}`);
    if (!this.existingTargets.has(statusName.trim().toLowerCase())) throw new JiraStatusNotFoundError(key, statusName, [...this.existingTargets]);
    this.statuses[key] = statusName;
  }
  async createSubtask(parentKey: string, subtask: JiraSubtaskInput) {
    this.guard(`subtask ${parentKey} ${subtask.summary}`);
    return { key: `${parentKey}-S` };
  }
  async listStatuses(projectKey: string) {
    this.guard(`statuses ${projectKey}`);
    return this.projectStatuses;
  }
}

/** Replaces JiraClients in a test module with a FakeJira. */
export class FakeJiraClients extends JiraClients {
  constructor(readonly jira: FakeJira = new FakeJira()) {
    super({ resolve: async () => ({}) } as never);
  }
  override async forRest() {
    return this.jira;
  }
  override hasMcp() {
    return true;
  }
  override async forMode() {
    return this.jira;
  }
}
