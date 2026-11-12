/** Errors the user should see as one line, and small output helpers. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const tty = () => Boolean(process.stdout.isTTY);
const paint = (code: number, text: string) => (tty() ? `\x1b[${code}m${text}\x1b[0m` : text);

export const red = (t: string) => paint(31, t);
export const green = (t: string) => paint(32, t);
export const yellow = (t: string) => paint(33, t);
export const dim = (t: string) => paint(2, t);

export const out = (line = '') => process.stdout.write(`${line}\n`);
