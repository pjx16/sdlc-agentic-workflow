import { Injectable } from '@nestjs/common';
import { DEFAULT_GLOBAL_SETTINGS, GlobalSettingsSchema, ProjectSettingsSchema, type ModelAlias, type StageName } from '@sdlc/shared';
import { JiraMcpError, type JiraMcpPort, type McpIssue, type McpSyncOp, type McpSyncResult } from '../../jira/jira-mcp-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentRunner, type StageResult } from '../agent-runner/agent-runner';
import { WorkerConfig } from '../worker-config';
import { type McpConfig, loadMcpConfig, mcpEnv } from './mcp-config';

/** The ticket shape the intake stage must return, shown to the model in its prompt (the schema itself is enforced by `--json-schema`). */
export const TICKET_SCHEMA_TEXT = JSON.stringify(
  { tickets: [{ key: 'ABC-1', summary: 'string', description: 'plain text or markdown', issuetype: 'Story | Bug | Task ...', labels: ['string'], priority: 'string or null', status: 'current status name' }] },
  null,
  2,
);

/**
 * Runs the two Jira stages for `JiraMcpClient` (F3). They are the only stages that get the MCP configuration and the credential it refers to,
 * on the proxy's port 3129, with no repository mount.
 */
@Injectable()
export class JiraMcpStages implements JiraMcpPort {
  private config: McpConfig | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: Pick<AgentRunner, 'run'>,
    private readonly worker: WorkerConfig,
    private readonly loadConfig: (file: string) => McpConfig = loadMcpConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private mcp(): McpConfig {
    const file = this.env.JIRA_MCP_CONFIG_PATH;
    if (!file) throw new JiraMcpError('JIRA_MCP_CONFIG_PATH is not set');
    return (this.config ??= this.loadConfig(file));
  }

  private async project(args: { projectId?: string; issueKey?: string }) {
    if (args.projectId) return this.prisma.project.findUniqueOrThrow({ where: { id: args.projectId } });
    const ticket = args.issueKey ? await this.prisma.ticket.findFirst({ where: { externalKey: args.issueKey }, include: { project: true } }) : null;
    if (ticket) return ticket.project;
    // No ticket yet (a first read): any project in MCP mode will do for bookkeeping.
    const any = await this.prisma.project.findFirst({ where: { jiraMode: 'mcp' }, orderBy: { createdAt: 'asc' } });
    if (!any) throw new JiraMcpError('No project uses Jira MCP mode');
    return any;
  }

  private async run(stage: 'jiraIntake' | 'jiraSync', project: Awaited<ReturnType<JiraMcpStages['project']>>, inputs: Record<string, string>, tools: string[]): Promise<StageResult> {
    const mcp = this.mcp();
    const settings = ProjectSettingsSchema.parse(project.settings);
    const stageSettings = settings.stages[stage as StageName];
    const globalRow = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const global = globalRow ? GlobalSettingsSchema.parse({ stageTimeoutMin: globalRow.stageTimeoutMin, modelAliases: globalRow.modelAliases }) : DEFAULT_GLOBAL_SETTINGS;
    return this.runner.run({
      projectId: project.id,
      stage,
      stack: project.stack,
      claudeMdMode: project.claudeMdMode,
      modelAlias: stageSettings.model as ModelAlias,
      modelAliases: global.modelAliases,
      maxTurns: stageSettings.maxTurns,
      stageTimeoutMin: global.stageTimeoutMin,
      inputs,
      jira: { tools, mcpConfigJson: mcp.json, env: mcpEnv(mcp, this.env), serverName: mcp.serverName },
    });
  }

  private async tools(kind: 'readTools' | 'writeTools'): Promise<string[]> {
    const row = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const jiraMcp = (row?.jiraMcp ?? DEFAULT_GLOBAL_SETTINGS.jiraMcp) as { readTools: string[]; writeTools: string[] };
    return jiraMcp[kind];
  }

  private fail(stage: string, result: Exclude<StageResult, { kind: 'done' }>): never {
    const why = result.kind === 'failed' ? result.reason : result.kind === 'needs_input' ? `it asked: ${result.question}` : result.kind;
    throw new JiraMcpError(`The ${stage} stage did not finish (${why})`.slice(0, 300));
  }

  async read(args: { jql: string; projectKey: string | null; projectId?: string; issueKey?: string }): Promise<McpIssue[]> {
    const project = await this.project(args);
    const result = await this.run('jiraIntake', project, { jql: args.jql, projectKey: args.projectKey ?? '', ticketSchema: TICKET_SCHEMA_TEXT }, await this.tools('readTools'));
    if (result.kind !== 'done') this.fail('jiraIntake', result);
    return ((result.envelope.data as { tickets?: McpIssue[] } | undefined)?.tickets ?? []) as McpIssue[];
  }

  async write(op: McpSyncOp): Promise<McpSyncResult> {
    const project = await this.project({ issueKey: op.issueKey });
    const result = await this.run('jiraSync', project, { syncPayload: JSON.stringify(op, null, 2) }, await this.tools('writeTools'));
    if (result.kind !== 'done') this.fail('jiraSync', result);
    return result.envelope.data as McpSyncResult;
  }
}
