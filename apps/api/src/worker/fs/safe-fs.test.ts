import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNoFollow, readTextNoFollow, readTextNoFollowSync, resolveInside, writeTextNoFollow, writeTextNoFollowSync } from './safe-fs';

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'safe-fs-'));
  root = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
});
afterEach(() => rmSync(path.dirname(root), { recursive: true, force: true }));

describe('safe-fs (S3)', () => {
  it('reads and writes normal files, creating parent directories', async () => {
    await writeTextNoFollow(root, 'docs/kb/a.md', '# A\n');
    expect(readFileSync(path.join(root, 'docs/kb/a.md'), 'utf8')).toBe('# A\n');
    expect(await readTextNoFollow(root, 'docs/kb/a.md')).toBe('# A\n');
    writeTextNoFollowSync(root, 'docs/kb/b.md', 'sync');
    expect(readTextNoFollowSync(root, 'docs/kb/b.md')).toBe('sync');
    expect(await readTextNoFollow(root, 'docs/kb/missing.md')).toBeNull();
  });

  it('overwrites an existing file completely', async () => {
    await writeTextNoFollow(root, 'a.txt', 'a long first version');
    await writeTextNoFollow(root, 'a.txt', 'short');
    expect(await readTextNoFollow(root, 'a.txt')).toBe('short');
  });

  it('refuses a symlinked file for reads and writes, and never touches its target', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.md'));
    expect(await readTextNoFollow(root, 'link.md')).toBeNull();
    expect(readTextNoFollowSync(root, 'link.md')).toBeNull();
    await expect(writeTextNoFollow(root, 'link.md', 'overwritten')).rejects.toThrow('symlink');
    expect(() => writeTextNoFollowSync(root, 'link.md', 'overwritten')).toThrow('symlink');
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses a symlinked parent directory', async () => {
    symlinkSync(outside, path.join(root, 'docs'));
    expect(await readTextNoFollow(root, 'docs/secret.txt')).toBeNull();
    await expect(writeTextNoFollow(root, 'docs/new.md', 'x')).rejects.toThrow('symlink');
    expect(await resolveInside(root, 'docs/secret.txt')).toBeNull();
  });

  it('refuses ../ and absolute paths that leave the root', async () => {
    expect(await resolveInside(root, '../outside/secret.txt')).toBeNull();
    expect(await resolveInside(root, path.join(outside, 'secret.txt'))).toBeNull();
    expect(await readTextNoFollow(root, '../outside/secret.txt')).toBeNull();
    await expect(writeTextNoFollow(root, '../outside/new.txt', 'x')).rejects.toThrow('Refusing');
  });

  it('returns null for a file over the size limit and for a directory', async () => {
    writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(100));
    mkdirSync(path.join(root, 'dir'));
    expect(await readTextNoFollow(root, 'big.txt', 99)).toBeNull();
    expect(await readTextNoFollow(root, 'big.txt', 100)).toHaveLength(100);
    expect(await readNoFollow(root, 'dir')).toBeNull();
  });

  it('works when the root itself is reached through a symlink', async () => {
    const alias = path.join(path.dirname(root), 'alias');
    symlinkSync(root, alias);
    await writeTextNoFollow(alias, 'a.txt', 'via alias');
    expect(await readTextNoFollow(alias, 'a.txt')).toBe('via alias');
  });
});
