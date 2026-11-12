import { Injectable } from '@nestjs/common';
import { ContainerRunner } from '../agent-runner/container-runner';
import { WorkerConfig } from '../worker-config';

const TAIL_LINES = 60;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CmdResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  /** Last 60 lines, which is all that is fed back to an agent. */
  tail: string;
  /** Everything (capped at 1 MB), for the log. */
  output: string;
}

/** Single-quotes a value for `bash -c`. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid file path');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Substitutes `{files}` in a test command template with quoted file paths. */
export function buildTestCommand(template: string, files: readonly string[]): string {
  return template.replaceAll('{files}', files.map(shellQuote).join(' '));
}

@Injectable()
export class VerifyService {
  constructor(
    private readonly runner: ContainerRunner,
    private readonly config: WorkerConfig,
  ) {}

  /** Runs one command (install, typecheck or tests) through `run-cmd` in a container without the Claude token. */
  async runCmd(args: { name: string; workspace: string; cmd: string; timeoutSec: number; files?: readonly string[] }): Promise<CmdResult> {
    const command = args.files ? buildTestCommand(args.cmd, args.files) : args.cmd;
    const lines: string[] = [];
    let bytes = 0;
    const result = await this.runner.run(
      {
        name: args.name,
        image: this.config.agentImage,
        cmd: ['run-cmd'],
        env: {
          CMD: command,
          VERIFY_TIMEOUT: String(args.timeoutSec),
          HTTPS_PROXY: 'http://proxy:3128',
          HTTP_PROXY: 'http://proxy:3128',
          NO_PROXY: 'localhost,127.0.0.1',
          npm_config_cache: '/npm-cache',
        },
        workspace: { path: args.workspace, readOnly: false },
        memory: this.config.agentMemory,
        cpus: this.config.agentCpus,
        // run-cmd enforces VERIFY_TIMEOUT itself; this is only a backstop (and covers install/startup).
        timeoutMs: (args.timeoutSec + 30) * 1000,
      },
      {
        onLine: (line) => {
          bytes += line.length + 1;
          if (bytes <= MAX_OUTPUT_BYTES) lines.push(line);
        },
      },
    );
    const timedOut = result.timedOut || result.exitCode === 124;
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut,
      tail: lines.slice(-TAIL_LINES).join('\n'),
      output: lines.join('\n'),
    };
  }
}
