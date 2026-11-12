import path from 'node:path';

/** Worker environment. DATA_DIR must be an absolute path that is identical on the host and in agent containers. */
export class WorkerConfig {
  readonly dataDir: string;
  readonly databaseUrl: string;
  readonly githubToken: string;
  /** Identity for every commit (GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL). */
  readonly authorName: string;
  readonly authorEmail: string;
  readonly mirrorPollMs: number;
  readonly agentImage: string;
  readonly agentMemory: string;
  readonly agentCpus: number;
  readonly claudeToken: string;
  /** Test hooks: bind mounts and environment added to every agent container (see docker-compose.test.yml). */
  readonly agentExtraBinds: string[];
  readonly agentExtraEnv: Record<string, string>;
  readonly guidelinesDir: string;
  /** Other secrets the worker holds, to redact from logs. */
  readonly extraSecrets: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing = ['DATA_DIR', 'DATABASE_URL'].filter((k) => !env[k]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    const dataDir = env.DATA_DIR as string;
    if (!path.isAbsolute(dataDir)) throw new Error('DATA_DIR must be an absolute path');
    this.dataDir = dataDir;
    this.databaseUrl = env.DATABASE_URL as string;
    this.githubToken = env.GITHUB_TOKEN ?? '';
    this.authorName = env.GIT_AUTHOR_NAME ?? '';
    this.authorEmail = env.GIT_AUTHOR_EMAIL ?? '';
    this.mirrorPollMs = Number(env.MIRROR_POLL_MS ?? 5000);
    this.agentImage = env.AGENT_IMAGE || 'sdlc-agent/agent:latest';
    this.agentMemory = env.AGENT_MEMORY || '4g';
    this.agentCpus = Number(env.AGENT_CPUS || 2);
    this.claudeToken = env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
    this.agentExtraBinds = (env.AGENT_EXTRA_BINDS ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    this.agentExtraEnv = Object.fromEntries(
      (env.AGENT_EXTRA_ENV ?? '')
        .split(',')
        .map((pair) => pair.trim())
        .filter((pair) => pair.includes('='))
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    );
    this.extraSecrets = [env.JIRA_API_TOKEN].filter((v): v is string => Boolean(v));
    this.guidelinesDir = env.GUIDELINES_DIR || path.resolve(__dirname, '../../../../guidelines');
  }

  runDir(stageRunId: string): string {
    return path.join(this.dataDir, 'runs', stageRunId);
  }

  logPath(stageRunId: string): string {
    return path.join(this.dataDir, 'logs', `${stageRunId}.log`);
  }

  workspacePath(projectId: string, key: string): string {
    return path.join(this.dataDir, 'workspaces', projectId, key);
  }

  mirrorPath(projectId: string): string {
    return path.join(this.dataDir, 'mirrors', `${projectId}.git`);
  }
}
