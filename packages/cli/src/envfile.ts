import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface EnvLine {
  /** The raw line, kept exactly so comments and order survive a rewrite. */
  raw: string;
  key?: string;
  value?: string;
}

const needsQuotes = (v: string) => /[\s#"']/.test(v);
const quote = (v: string) => (needsQuotes(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v);

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

/** Parses .env text line by line; comments and blank lines are kept as they are. */
export function parseEnv(text: string): EnvLine[] {
  return text.split('\n').map((raw) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    return m ? { raw, key: m[1], value: unquote(m[2] as string) } : { raw };
  });
}

export function getEnv(text: string, key: string): string | undefined {
  return parseEnv(text).find((l) => l.key === key)?.value;
}

/** Replaces `KEY=` if present, otherwise appends it. */
export function setEnv(text: string, key: string, value: string): string {
  const line = `${key}=${quote(value)}`;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}=`).test(l));
  if (i >= 0) {
    lines[i] = line;
    return lines.join('\n');
  }
  const body = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  return `${body}${line}\n`;
}

/** Writes to a temporary file with mode 0600, then renames it over the target. */
export function writeEnvFile(file: string, text: string): void {
  const dir = mkdtempSync(path.join(path.dirname(file), '.env-'));
  const tmp = path.join(dir, 'env');
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const readEnvFile = (file: string): string => readFileSync(file, 'utf8');
