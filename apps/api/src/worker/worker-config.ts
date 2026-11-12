import path from 'node:path';

/** Worker environment. Tokens and the git identity are not here: they come from CredentialsService (env first, then the database). DATA_DIR must be an absolute path that is identical on the host and in agent containers. */
export class WorkerConfig {
  readonly dataDir: string;
  readonly databaseUrl: string;
  readonly mirrorPollMs: number;
  readonly agentImage: string;
  readonly agentMemory: string;
  readonly agentCpus: number;
  /** Test hooks: bind mounts and environment added to every agent container (see docker-compose.test.yml). */
  readonly agentExtraBinds: string[];
  readonly agentExtraEnv: Record<string, string>;
  readonly guidelinesDir: string;
  /** Test hook: extra repository URL prefixes the worker may push to (the default is github.com only). Used with local bare remotes. */
  readonly pushUrlPrefixes: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing = ['DATA_DIR', 'DATABASE_URL'].filter((k) => !env[k]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    const dataDir = env.DATA_DIR as string;
    if (!path.isAbsolute(dataDir)) throw new Error('DATA_DIR must be an absolute path');
    this.dataDir = dataDir;
    this.databaseUrl = env.DATABASE_URL as string;
    this.mirrorPollMs = Number(env.MIRROR_POLL_MS ?? 5000);
    this.agentImage = env.AGENT_IMAGE || 'sdlc-agent/agent:latest';
    this.agentMemory = env.AGENT_MEMORY || '4g';
    this.agentCpus = Number(env.AGENT_CPUS || 2);
    this.agentExtraBinds = (env.AGENT_EXTRA_BINDS ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    this.agentExtraEnv = Object.fromEntries(
      (env.AGENT_EXTRA_ENV ?? '')
        .split(',')
        .map((pair) => pair.trim())
        .filter((pair) => pair.includes('='))
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    );
    this.pushUrlPrefixes = ['https://github.com/', ...(env.TEST_PUSH_URL_PREFIXES ?? '').split(',').map((p) => p.trim()).filter(Boolean)];
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
