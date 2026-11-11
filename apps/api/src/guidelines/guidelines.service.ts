import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';

export const MAX_GUIDELINE_BYTES = 200_000;

export interface TreeNode {
  name: string;
  /** Path relative to the guidelines directory, with `/` separators. */
  path: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
}

const invalid = (message: string) => new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, message, { path: message });

/**
 * Turns a request path into a path inside `root`, or throws. Only markdown files below the guidelines directory are
 * reachable: no absolute paths, no `..`, no backslashes, no NUL bytes, no hidden segments, and a `.md` extension.
 */
export function resolveGuidelinePath(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.trim() === '') throw invalid('a path is required');
  if (rel.includes('\0')) throw invalid('invalid path');
  if (rel.includes('\\')) throw invalid('use / as the path separator');
  if (path.isAbsolute(rel) || rel.startsWith('/')) throw invalid('the path must be relative to the guidelines directory');
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw invalid('the path must not contain empty, . or .. segments');
  if (segments.some((s) => s.startsWith('.'))) throw invalid('hidden files are not available');
  if (!rel.endsWith('.md')) throw invalid('only .md files can be read or written');
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  if (!full.startsWith(resolvedRoot + path.sep)) throw invalid('the path leaves the guidelines directory');
  return full;
}

/** Wildcard route parameters arrive as an array of segments (Express 5) or as one string. */
export function wildcardToPath(param: string | string[] | undefined): string {
  return Array.isArray(param) ? param.join('/') : (param ?? '');
}

/** Reads and edits the markdown files under `guidelines/` (BUILD_PLAN 8, 3.8). Changes apply from the next stage run. */
@Injectable()
export class GuidelinesService {
  readonly root = path.resolve(process.env.GUIDELINES_DIR || path.join(__dirname, '../../../../guidelines'));

  /** The file tree: directories first, then markdown files, each sorted by name. Symlinks and hidden entries are skipped. */
  async tree(dir = this.root, prefix = ''): Promise<TreeNode[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) nodes.push({ name: e.name, path: rel, type: 'dir', children: await this.tree(path.join(dir, e.name), rel) });
      else if (e.isFile() && e.name.endsWith('.md')) nodes.push({ name: e.name, path: rel, type: 'file' });
    }
    return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  async read(rel: string): Promise<{ path: string; content: string }> {
    const full = resolveGuidelinePath(this.root, rel);
    const real = await realpath(full).catch(() => null);
    if (!real) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Guideline not found');
    this.assertInside(real, 'the file is outside the guidelines directory');
    if (!(await stat(real)).isFile()) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Guideline not found');
    return { path: rel, content: await readFile(real, 'utf8') };
  }

  /** Writes a file. It may be new, but its directory must already exist: the tree structure is not edited here. */
  async write(rel: string, content: unknown): Promise<{ path: string; bytes: number }> {
    const full = resolveGuidelinePath(this.root, rel);
    if (typeof content !== 'string') throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'content must be a string', { content: 'required' });
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_GUIDELINE_BYTES) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'the file is too large', { content: `must be at most ${MAX_GUIDELINE_BYTES} bytes` });

    const dir = await realpath(path.dirname(full)).catch(() => null);
    if (!dir) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'the directory does not exist', { path: 'the directory does not exist' });
    this.assertInside(path.join(dir, path.basename(full)), 'the path leaves the guidelines directory');
    const existing = await lstat(full).catch(() => null);
    if (existing && !existing.isFile()) throw invalid('the path is not a regular file'); // a symlink or directory

    // Write to a temporary file and rename it, so a reader never sees a half-written guideline.
    const tmp = path.join(dir, `.${path.basename(full)}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, full);
    return { path: rel, bytes };
  }

  private assertInside(real: string, message: string): void {
    const root = this.rootReal ?? this.root;
    if (!real.startsWith(root + path.sep)) throw invalid(message);
  }

  private rootReal: string | null = null;

  async onInit(): Promise<void> {
    this.rootReal = await realpath(this.root).catch(() => this.root);
  }
}
