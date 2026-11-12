import { type SpawnOptions, spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Stream the child's output to ours instead of capturing it. */
  inherit?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Runs a program with an argument array. Never uses a shell. A missing program resolves with code 127. */
export function run(command: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const options: SpawnOptions = { cwd: opts.cwd, env: opts.env ?? process.env, stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] };
    const child = spawn(command, [...args], options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr || err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
