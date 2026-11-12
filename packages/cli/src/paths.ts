import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `--dir <path>`, else `$SDLC_AGENT_HOME`, else `~/.sdlc-agent`. */
export function resolveInstallDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = flag || env.SDLC_AGENT_HOME || path.join(os.homedir(), '.sdlc-agent');
  return path.resolve(chosen);
}

/** The files shipped inside the package (compose file, guidelines, changelog). */
export const assetsDir = (): string => path.join(__dirname, '../assets');

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export const MANIFEST = '.sdlc-agent.json';
export const COMPOSE_PROJECT = 'sdlc-agent';
