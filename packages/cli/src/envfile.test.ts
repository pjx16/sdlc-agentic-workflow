import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEnv, parseEnv, setEnv, writeEnvFile } from './envfile';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sdlc-env-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('envfile', () => {
  const text = '# header\nA=1\n\n# note\nB="two words"\n';

  it('keeps comments and order when a value is replaced or appended', () => {
    const replaced = setEnv(text, 'A', '9');
    expect(replaced).toBe('# header\nA=9\n\n# note\nB="two words"\n');
    expect(setEnv(replaced, 'C', 'x')).toBe('# header\nA=9\n\n# note\nB="two words"\nC=x\n');
  });

  it('reads quoted values back', () => {
    expect(getEnv(text, 'B')).toBe('two words');
    expect(getEnv(text, 'A')).toBe('1');
    expect(getEnv(text, 'MISSING')).toBeUndefined();
    expect(parseEnv(text).filter((l) => l.key)).toHaveLength(2);
  });

  it('quotes values that contain spaces or #, and round-trips them', () => {
    const t = setEnv(setEnv('', 'P', 'a b'), 'Q', 'x#y');
    expect(t).toBe('P="a b"\nQ="x#y"\n');
    expect(getEnv(t, 'P')).toBe('a b');
    expect(getEnv(t, 'Q')).toBe('x#y');
  });

  it('writes the file with mode 0600 (also over an existing looser file) and leaves no temp files', () => {
    const dir = tmp();
    const file = path.join(dir, '.env');
    writeFileSync(file, 'old', { mode: 0o644 });
    writeEnvFile(file, 'A=1\n');
    expect(readFileSync(file, 'utf8')).toBe('A=1\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['.env']);
  });
});
