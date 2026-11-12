import path from 'node:path';

/** Worker environment. DATA_DIR must be an absolute path that is identical on the host and in agent containers. */
export class WorkerConfig {
  readonly dataDir: string;
  readonly databaseUrl: string;
  readonly githubToken: string;
  readonly mirrorPollMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing = ['DATA_DIR', 'DATABASE_URL'].filter((k) => !env[k]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    const dataDir = env.DATA_DIR as string;
    if (!path.isAbsolute(dataDir)) throw new Error('DATA_DIR must be an absolute path');
    this.dataDir = dataDir;
    this.databaseUrl = env.DATABASE_URL as string;
    this.githubToken = env.GITHUB_TOKEN ?? '';
    this.mirrorPollMs = Number(env.MIRROR_POLL_MS ?? 5000);
  }

  mirrorPath(projectId: string): string {
    return path.join(this.dataDir, 'mirrors', `${projectId}.git`);
  }
}
