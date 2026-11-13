import type { JiraFacts } from '@sdlc/shared';
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
  commentBodies: Record<string, string[]> = {};
  async comment(key: string, markdown?: string, marker?: string) {
    this.guard(`comment ${key}`);
    const list = (this.commentBodies[key] ??= []);
    if (marker && list.some((c) => c.includes(marker))) return;
    list.push(marker ? `${markdown}\n\n${marker}` : (markdown ?? ''));
  }
  async transition(key: string, statusName: string) {
    this.guard(`transition ${key} -> ${statusName}`);
    if ((this.statuses[key] ?? '').trim().toLowerCase() === statusName.trim().toLowerCase()) return;
    if (!this.existingTargets.has(statusName.trim().toLowerCase())) throw new JiraStatusNotFoundError(key, statusName, [...this.existingTargets]);
    this.statuses[key] = statusName;
  }
  createdSubtasks: Record<string, string> = {}; // marker -> key
  async createSubtask(parentKey: string, subtask: JiraSubtaskInput) {
    this.guard(`subtask ${parentKey} ${subtask.summary}`);
    if (subtask.marker && this.createdSubtasks[subtask.marker]) return { key: this.createdSubtasks[subtask.marker] as string };
    const key = `${parentKey}-S`;
    if (subtask.marker) this.createdSubtasks[subtask.marker] = key;
    return { key };
  }
  facts: JiraFacts = {
    projectName: 'Demo',
    issueTypes: [{ name: 'Story', subtask: false }, { name: 'Bug', subtask: false }, { name: 'Epic', subtask: false }, { name: 'Sub-task', subtask: true }],
    statusesByType: [{ type: 'Story', statuses: [{ name: 'To Do', category: 'new' }, { name: 'In Progress', category: 'indeterminate' }, { name: 'Done', category: 'done' }] }],
    labels: ['backend'],
  };
  async projectFacts(projectKey: string) {
    this.guard(`facts ${projectKey}`);
    return this.facts;
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
  override async forMode() {
    return this.jira;
  }
}
