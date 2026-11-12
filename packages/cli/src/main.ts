import { parseArgs } from 'node:util';
import { resetAdmin, uninstall } from './admin';
import { down, logs, status, up } from './commands';
import { runDoctor, envFor } from './doctor';
import { init } from './init';
import { packageVersion, resolveInstallDir } from './paths';
import { CliError, out, red } from './ui';
import { upgrade } from './upgrade';

const HELP = `sdlc-agent — install and run the sdlc-agent stack

Usage: sdlc-agent <command> [options]

Commands:
  init           Create the install folder, generate secrets, start the stack and open the setup wizard
  up             Start (and update the images of) the stack
  down           Stop the stack; data is kept
  status         Show the version, containers and setup state
  logs [service] Show logs (-f to follow)
  upgrade        Move the installation to this CLI's version (backs up the database first)
  doctor         Check Docker, ports and disk space
  reset-admin    Forgot the password: remove the admin account and print a new setup code
  uninstall      Stop the stack and delete its database

Options:
  --dir <path>   Install folder (default: $SDLC_AGENT_HOME or ~/.sdlc-agent)
  --version, --help

init:    --bind <addr> (default 127.0.0.1)  --no-start  --no-open  --force
upgrade: --yes  --skip-backup
reset-admin: --yes
uninstall: --purge
`;

export async function run(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${process.stderr.isTTY ? red(err.message) : err.message}\n`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${process.stderr.isTTY ? red(message) : message}\n`);
    if (process.env.SDLC_AGENT_DEBUG === '1' && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    return 1;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string' },
        bind: { type: 'string' },
        'no-start': { type: 'boolean' },
        'no-open': { type: 'boolean' },
        force: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'skip-backup': { type: 'boolean' },
        purge: { type: 'boolean' },
        follow: { type: 'boolean', short: 'f' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) return out(packageVersion()), 0;
  const command = positionals[0];
  if (values.help || !command) return out(HELP), command || values.help ? 0 : 2;

  if (process.platform === 'win32') throw new CliError('Windows is not supported yet; use WSL2 and run sdlc-agent inside it.');
  const dir = resolveInstallDir(values.dir);

  switch (command) {
    case 'init':
      await init({ dir, bind: values.bind ?? '127.0.0.1', start: !values['no-start'], open: !values['no-open'], force: Boolean(values.force) });
      return 0;
    case 'up':
      await up({ dir });
      return 0;
    case 'down':
      await down(dir);
      return 0;
    case 'status':
      await status(dir);
      return 0;
    case 'logs':
      await logs(dir, positionals[1], Boolean(values.follow));
      return 0;
    case 'upgrade':
      await upgrade({ dir, yes: Boolean(values.yes), skipBackup: Boolean(values['skip-backup']) });
      return 0;
    case 'doctor':
      return (await runDoctor({ dir, env: envFor(dir) })).ok ? 0 : 1;
    case 'reset-admin':
      await resetAdmin(dir, Boolean(values.yes));
      return 0;
    case 'uninstall':
      await uninstall(dir, Boolean(values.purge));
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}
