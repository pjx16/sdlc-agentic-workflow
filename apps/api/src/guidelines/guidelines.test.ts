import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuidelinesService, MAX_GUIDELINE_BYTES, resolveGuidelinePath, wildcardToPath } from './guidelines.service';

let tmp: string;
let root: string;
let service: GuidelinesService;

const put = (rel: string, content = 'x') => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};
const rejects = async (p: Promise<unknown>) => expect(await p.then(() => null, (e) => e)).toMatchObject({ status: 400 });

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-guidelines-'));
  root = path.join(tmp, 'guidelines');
  mkdirSync(root);
  process.env.GUIDELINES_DIR = root;
  service = new GuidelinesService();
  await service.onInit();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
  put('default-CLAUDE.md', '# Rules');
  put('stacks/nestjs.md', '# Nest');
  put('stages/plan.md', '# Plan');
  writeFileSync(path.join(tmp, 'secret.md'), 'outside the guidelines directory');
});

describe('resolveGuidelinePath: the path guard (BUILD_PLAN section 11)', () => {
  it('accepts markdown files inside the directory', () => {
    expect(resolveGuidelinePath(root, 'default-CLAUDE.md')).toBe(path.join(root, 'default-CLAUDE.md'));
    expect(resolveGuidelinePath(root, 'stages/kb-build.md')).toBe(path.join(root, 'stages/kb-build.md'));
  });

  it('rejects every traversal attempt', () => {
    const attacks = [
      '../secret.md', '../../etc/passwd.md', 'stages/../../secret.md', 'a/../../secret.md', '..', '../', 'stages/..',
      '/etc/passwd.md', '/abs/path.md', '//server/share.md', '..\\secret.md', 'stages\\plan.md', 'C:\\x.md', 'a/./b.md', './a.md',
      'stages//plan.md', 'a.md\0.txt', 'a\0.md', '', '   ', '.hidden.md', 'stages/.hidden.md', '.git/config.md',
    ];
    for (const a of attacks) expect(() => resolveGuidelinePath(root, a), JSON.stringify(a)).toThrow();
  });

  it('rejects anything that is not markdown', () => {
    for (const a of ['plan.txt', 'plan', 'plan.md.exe', 'plan.MD', 'stages/plan.json', 'stages/']) expect(() => resolveGuidelinePath(root, a), a).toThrow();
  });

  it('rejects percent-encoded and unicode lookalike tricks by treating them as plain names', () => {
    expect(resolveGuidelinePath(root, '%2e%2e%2fsecret.md')).toBe(path.join(root, '%2e%2e%2fsecret.md')); // a literal file name, still inside
    expect(() => resolveGuidelinePath(root, '..％2fsecret.md')).toThrow('hidden'); // starts with a dot, so it is refused as a hidden name
    expect(resolveGuidelinePath(root, 'a％2fb.md')).toBe(path.join(root, 'a％2fb.md')); // a full-width % is just a character
  });

  it('turns a wildcard parameter into a path', () => {
    expect(wildcardToPath(['stages', 'plan.md'])).toBe('stages/plan.md');
    expect(wildcardToPath('a.md')).toBe('a.md');
    expect(wildcardToPath(undefined)).toBe('');
  });
});

describe('GuidelinesService.tree', () => {
  it('lists directories first, then markdown files, sorted, with relative paths', async () => {
    put('review-checklist.md');
    const tree = await service.tree();
    expect(tree.map((n) => `${n.type}:${n.path}`)).toEqual(['dir:stacks', 'dir:stages', 'file:default-CLAUDE.md', 'file:review-checklist.md']);
    expect(tree[1]?.children?.map((c) => c.path)).toEqual(['stages/plan.md']);
  });

  it('skips non-markdown files, hidden entries and symlinks', async () => {
    put('notes.txt');
    put('.hidden.md');
    symlinkSync(path.join(tmp, 'secret.md'), path.join(root, 'link.md'));
    const names = JSON.stringify(await service.tree());
    expect(names).not.toContain('notes.txt');
    expect(names).not.toContain('.hidden.md');
    expect(names).not.toContain('link.md');
  });

  it('is empty for a missing directory', async () => {
    const other = new GuidelinesService();
    Object.defineProperty(other, 'root', { value: path.join(tmp, 'nope') });
    expect(await other.tree()).toEqual([]);
  });
});

describe('GuidelinesService.read', () => {
  it('returns the content', async () => {
    expect(await service.read('stacks/nestjs.md')).toEqual({ path: 'stacks/nestjs.md', content: '# Nest' });
  });
  it('404s for a missing file or a directory, and 400s for traversal', async () => {
    expect(await service.read('nope.md').catch((e) => e)).toMatchObject({ status: 404 });
    expect(await service.read('stacks.md').catch((e) => e)).toMatchObject({ status: 404 });
    await rejects(service.read('../secret.md'));
    await rejects(service.read('/etc/passwd.md'));
  });
  it('does not follow a symlink out of the directory', async () => {
    symlinkSync(path.join(tmp, 'secret.md'), path.join(root, 'link.md'));
    await rejects(service.read('link.md'));
    const dirLink = path.join(root, 'outdir');
    symlinkSync(tmp, dirLink);
    await rejects(service.read('outdir/secret.md'));
  });
});

describe('GuidelinesService.write', () => {
  it('overwrites an existing file and creates a new one in an existing directory', async () => {
    expect(await service.write('default-CLAUDE.md', '# New rules')).toEqual({ path: 'default-CLAUDE.md', bytes: 11 });
    expect(readFileSync(path.join(root, 'default-CLAUDE.md'), 'utf8')).toBe('# New rules');
    await service.write('stages/breakdown.md', '# Breakdown');
    expect(readFileSync(path.join(root, 'stages/breakdown.md'), 'utf8')).toBe('# Breakdown');
  });

  it('leaves no temporary file behind, and the change is visible at once', async () => {
    await service.write('stages/plan.md', 'v2');
    expect(readdirSync(path.join(root, 'stages'))).toEqual(['plan.md']);
    expect((await service.read('stages/plan.md')).content).toBe('v2');
  });

  it('rejects traversal, non-markdown paths and absolute paths without writing anything', async () => {
    for (const bad of ['../evil.md', 'stages/../../evil.md', '/tmp/evil.md', 'evil.txt', '..\\evil.md', 'a\0.md']) await rejects(service.write(bad, 'x'));
    expect(existsSync(path.join(tmp, 'evil.md'))).toBe(false);
    expect(readdirSync(tmp).sort()).toEqual(['guidelines', 'secret.md']);
  });

  it('does not create directories', async () => {
    await rejects(service.write('newdir/file.md', 'x'));
    expect(existsSync(path.join(root, 'newdir'))).toBe(false);
  });

  it('does not write through a symlinked file or directory', async () => {
    symlinkSync(path.join(tmp, 'secret.md'), path.join(root, 'link.md'));
    await rejects(service.write('link.md', 'overwritten!'));
    expect(readFileSync(path.join(tmp, 'secret.md'), 'utf8')).toBe('outside the guidelines directory');
    symlinkSync(tmp, path.join(root, 'outdir'));
    await rejects(service.write('outdir/evil.md', 'x'));
    expect(existsSync(path.join(tmp, 'evil.md'))).toBe(false);
  });

  it('validates the content', async () => {
    await rejects(service.write('default-CLAUDE.md', undefined));
    await rejects(service.write('default-CLAUDE.md', 42));
    await rejects(service.write('default-CLAUDE.md', 'x'.repeat(MAX_GUIDELINE_BYTES + 1)));
    expect((await service.read('default-CLAUDE.md')).content).toBe('# Rules');
    await service.write('default-CLAUDE.md', ''); // an empty file is allowed
    expect((await service.read('default-CLAUDE.md')).content).toBe('');
  });
});
