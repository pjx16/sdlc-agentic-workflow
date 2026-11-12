import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { compose } from './compose';
import { dashboardUrl } from './commands';
import { setEnv, writeEnvFile } from './envfile';
import { run } from './proc';
import { ask, confirm } from './prompt';
import { generateSetupCode } from './secrets';
import { CliError, out } from './ui';

export async function resetAdmin(dir: string, yes: boolean): Promise<void> {
  const envFile = path.join(dir, '.env');
  if (!existsSync(envFile)) throw new CliError(`No installation found at ${dir}. Run \`sdlc-agent init\` first.`);
  if (!yes && !(await confirm('This deletes the admin password and signs everyone out. Continue?'))) throw new CliError('Cancelled.');
  const res = await compose(dir, ['exec', '-T', 'api', 'node', 'dist/scripts/reset-admin.js']);
  if (res.code !== 0) throw new CliError(`Could not reset the admin account. Is the stack running (\`sdlc-agent up\`)? ${res.stderr.trim().split('\n').pop() ?? ''}`);
  const code = generateSetupCode();
  writeEnvFile(envFile, setEnv(readFileSync(envFile, 'utf8'), 'SETUP_CODE', code));
  // Recreate the API (a plain restart would keep its old environment) so it starts with the new code.
  if ((await compose(dir, ['up', '-d', '--wait', 'api'], { inherit: true })).code !== 0) throw new CliError('The API did not restart. See `sdlc-agent logs api`.');
  out();
  out(`Admin password removed. Open ${dashboardUrl(dir)} and create a new one.`);
  out(`Setup code: ${code}`);
}

export async function uninstall(dir: string, purge: boolean): Promise<void> {
  if (!existsSync(path.join(dir, '.env'))) throw new CliError(`No installation found at ${dir}.`);
  if (!process.stdin.isTTY) throw new CliError('uninstall asks for confirmation and needs a terminal.');
  out(`This stops sdlc-agent and DELETES THE DATABASE (tickets, projects, saved tokens) of the installation in ${dir}.`);
  if ((await ask('Type "uninstall" to continue: ')) !== 'uninstall') throw new CliError('Cancelled.');
  const res = await compose(dir, ['down', '--volumes'], { inherit: true });
  if (res.code !== 0) throw new CliError('`docker compose down --volumes` failed.');
  await run('docker', ['network', 'rm', 'sdlc_agent_net']);
  await run('docker', ['volume', 'rm', 'sdlc_npm_cache']);
  if (purge) {
    rmSync(dir, { recursive: true, force: true });
    out(`Removed ${dir}.`);
  } else out(`The installation folder was kept (it holds your .env and backups): ${dir}\nRemove it with --purge, or delete it yourself.`);
}
