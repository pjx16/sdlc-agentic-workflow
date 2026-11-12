import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageRequest, StageResult } from '../agent-runner/agent-runner';
import { StepsHarness } from '../../testing/steps-harness';
import { JiraMcpClient } from '../../jira/jira-mcp-client';
import { JiraMcpStages } from './jira-mcp-stages';
import { parseMcpConfig } from './mcp-config';

const CONFIG = parseMcpConfig(JSON.stringify({ mcpServers: { atlassian: { type: 'http', url: 'https://mcp.example.com/v2/mcp', headers: { Authorization: 'Basic ${JIRA_MCP_AUTH}' } } } }));
const ENV = { JIRA_MCP_CONFIG_PATH: '/cfg/mcp.json', JIRA_MCP_AUTH: 'tok-123', GITHUB_TOKEN: 'ghp_secret', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' } as NodeJS.ProcessEnv;

describe('JiraMcpStages (F3, MCP mode)', () => {
  let h: StepsHarness;
  let requests: StageRequest[] = [];
  let answer: (req: StageRequest) => StageResult;
  let client: JiraMcpClient;

  const done = (data: unknown): StageResult => ({ kind: 'done', envelope: { status: 'done', summary: 's', data } as never, stageRunId: 'run-1', attempts: 1 });

  beforeAll(async () => {
    h = await StepsHarness.create();
    const runner = { run: async (req: StageRequest) => (requests.push(req), answer(req)) };
    client = new JiraMcpClient(new JiraMcpStages(h.prisma, runner as never, h.config, () => CONFIG, ENV));
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    requests = [];
    await h.setProject({ jiraMode: 'mcp', jiraProjectKey: 'ABC', jiraJql: 'project = ABC', settings: {} });
    await h.prisma.globalSettings.deleteMany();
  });

  const project = () => h.prisma.project.findUniqueOrThrow({ where: { id: h.projectId } });

  it('intake: a jiraIntake stage with the JQL, only the read tools, the MCP config and only the credential it refers to, and no workspace', async () => {
    answer = () => done({ tickets: [{ key: 'ABC-1', summary: 'Fix', description: 'd', issuetype: 'Bug', labels: [], priority: null, status: 'To Do' }] });
    const tickets = await client.searchTickets(await project());
    expect(tickets).toEqual([{ key: 'ABC-1', summary: 'Fix', description: 'd', issuetype: 'Bug', labels: [], priority: null }]);
    const req = requests[0] as StageRequest;
    expect(req).toMatchObject({ stage: 'jiraIntake', modelAlias: 'haiku', maxTurns: 10, projectId: h.projectId });
    expect(req.workspacePath).toBeUndefined();
    expect(req.inputs).toMatchObject({ jql: 'project = ABC', projectKey: 'ABC' });
    expect(req.jira?.tools).toEqual(['getJiraIssue', 'listJiraIssueComments', 'searchJiraIssuesUsingJql', 'getAccessibleAtlassianResources']);
    expect(req.jira?.serverName).toBe('atlassian');
    expect(req.jira?.mcpConfigJson).toBe(CONFIG.json);
    // The Jira credential reaches this stage and nothing else from the worker's environment does.
    expect(req.jira?.env).toEqual({ JIRA_MCP_AUTH: 'tok-123' });
    expect(JSON.stringify(req)).not.toContain('ghp_secret');
    expect(JSON.stringify(req)).not.toContain('oauth-secret');
  });

  it('intake: malformed output is rejected (bad key, wrong project)', async () => {
    answer = () => done({ tickets: [{ key: 'abc-1; rm', summary: 's', description: '', issuetype: 'Bug', labels: [], priority: null }] });
    await expect(client.searchTickets(await project())).rejects.toThrow('invalid issue key');
    answer = () => done({ tickets: [{ key: 'EVIL-1', summary: 's', description: '', issuetype: 'Bug', labels: [], priority: null }] });
    await expect(client.searchTickets(await project())).rejects.toThrow('not in project ABC');
  });

  it('intake: a stage that did not finish is an error, not an empty list', async () => {
    answer = () => ({ kind: 'failed', reason: 'Timed out', stageRunId: 'r', attempts: 2 });
    await expect(client.searchTickets(await project())).rejects.toThrow('jiraIntake stage did not finish (Timed out)');
  });

  it('write-back: a jiraSync stage with one fixed payload and only the write tools', async () => {
    const t = await h.ticket({ externalKey: 'ABC-7', source: 'jira' });
    answer = () => done({ applied: true, detail: 'moved' });
    await client.transition('ABC-7', 'In Progress');
    const req = requests[0] as StageRequest;
    expect(req).toMatchObject({ stage: 'jiraSync', modelAlias: 'haiku', maxTurns: 8, projectId: h.projectId });
    expect(req.workspacePath).toBeUndefined();
    expect(JSON.parse((req.inputs as { syncPayload: string }).syncPayload)).toEqual({ operation: 'transition', issueKey: 'ABC-7', targetStatus: 'In Progress' });
    expect(req.jira?.tools).toEqual(['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment']);
    expect(req.jira?.env).toEqual({ JIRA_MCP_AUTH: 'tok-123' });
    void t;
  });

  it('write-back: creating a sub-task returns the key the stage reports', async () => {
    await h.ticket({ externalKey: 'ABC-8', source: 'jira' });
    answer = () => done({ applied: true, detail: 'created', createdKey: 'ABC-30' });
    expect(await client.createSubtask('ABC-8', { summary: 'sub', description: 'body' })).toEqual({ key: 'ABC-30' });
  });

  it('uses the tool lists from the global settings', async () => {
    await h.prisma.globalSettings.create({ data: { id: 'global', jiraMcp: { readTools: ['onlyThis'], writeTools: [] } } });
    answer = () => done({ tickets: [] });
    await client.searchTickets(await project());
    expect(requests[0]?.jira?.tools).toEqual(['onlyThis']);
  });

  it('fails clearly when the MCP config is missing or a referenced variable is not set', async () => {
    answer = () => done({ tickets: [] });
    const noPath = new JiraMcpClient(new JiraMcpStages(h.prisma, { run: async () => done({}) } as never, h.config, () => CONFIG, {} as NodeJS.ProcessEnv));
    await expect(noPath.searchTickets(await project())).rejects.toThrow('JIRA_MCP_CONFIG_PATH is not set');
    const noVar = new JiraMcpClient(new JiraMcpStages(h.prisma, { run: async () => done({}) } as never, h.config, () => CONFIG, { JIRA_MCP_CONFIG_PATH: '/x' } as NodeJS.ProcessEnv));
    await expect(noVar.searchTickets(await project())).rejects.toThrow('JIRA_MCP_AUTH, which is not set');
  });
});
