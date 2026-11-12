import path from 'node:path';
import { COMPOSE_PROJECT } from './paths';
import { type RunOptions, type RunResult, run } from './proc';

/** `docker compose` against the install folder: its compose file, its .env, project name `sdlc-agent`. */
export function composeArgs(dir: string, args: readonly string[]): string[] {
  return ['compose', '--project-directory', dir, '-f', path.join(dir, 'docker-compose.yml'), '--env-file', path.join(dir, '.env'), '-p', COMPOSE_PROJECT, ...args];
}

export function compose(dir: string, args: readonly string[], opts: Pick<RunOptions, 'inherit'> = {}): Promise<RunResult> {
  return run('docker', composeArgs(dir, args), { inherit: opts.inherit });
}

/** True when any service of the stack is running. */
export async function isRunning(dir: string): Promise<boolean> {
  const res = await compose(dir, ['ps', '--status', 'running', '-q']);
  return res.code === 0 && res.stdout.trim() !== '';
}
