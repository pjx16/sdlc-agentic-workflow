import { createInterface } from 'node:readline/promises';

/** Asks a question on the terminal and returns the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}
