import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * File access inside a workspace that an agent has written to (S3). An agent can leave symlinks behind (for example
 * `docs/kb/a.md -> /proc/self/environ`); the worker runs as root and must never follow them. These helpers refuse any path
 * that leaves the root or passes through a symlink, and open files with O_NOFOLLOW. A race between the check and the open is
 * acceptable: the worker only reads these files after the agent container has exited.
 */

const DEFAULT_MAX_BYTES = 1_048_576;

/** The directory components between `rootReal` and `full`, each as a cumulative path. */
function componentsBelow(rootReal: string, full: string): string[] {
  const parts = path.relative(rootReal, full).split(path.sep).filter(Boolean);
  return parts.map((_, i) => path.join(rootReal, ...parts.slice(0, i + 1)));
}

function underRoot(rootReal: string, full: string): boolean {
  return full.startsWith(rootReal + path.sep);
}

const isMissing = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');

/** The absolute path of `rel` inside `root`, or null if it escapes the root or an existing component is a symlink. */
export async function resolveInside(root: string, rel: string): Promise<string | null> {
  if (rel.includes('\0')) return null;
  const rootReal = await realpath(root);
  const full = path.resolve(rootReal, rel);
  if (!underRoot(rootReal, full)) return null;
  for (const part of componentsBelow(rootReal, full)) {
    try {
      if ((await lstat(part)).isSymbolicLink()) return null;
    } catch (err) {
      if (isMissing(err)) break; // components that do not exist yet are allowed
      throw err;
    }
  }
  return full;
}

export function resolveInsideSync(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const rootReal = realpathSync(root);
  const full = path.resolve(rootReal, rel);
  if (!underRoot(rootReal, full)) return null;
  for (const part of componentsBelow(rootReal, full)) {
    try {
      if (lstatSync(part).isSymbolicLink()) return null;
    } catch (err) {
      if (isMissing(err)) break;
      throw err;
    }
  }
  return full;
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
const isRefusal = (err: unknown) => isMissing(err) || (err as NodeJS.ErrnoException).code === 'ELOOP';

/** The bytes of a regular file inside `root`, or null if it is missing, a symlink, not a regular file, or larger than `maxBytes`. */
export async function readNoFollow(root: string, rel: string, maxBytes = DEFAULT_MAX_BYTES): Promise<Buffer | null> {
  const full = await resolveInside(root, rel);
  if (!full) return null;
  let handle;
  try {
    handle = await open(full, READ_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await handle.readFile();
  } catch (err) {
    if (isRefusal(err)) return null;
    throw err;
  } finally {
    await handle?.close();
  }
}

export function readNoFollowSync(root: string, rel: string, maxBytes = DEFAULT_MAX_BYTES): Buffer | null {
  const full = resolveInsideSync(root, rel);
  if (!full) return null;
  let fd: number | undefined;
  try {
    fd = openSync(full, READ_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } catch (err) {
    if (isRefusal(err)) return null;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readTextNoFollow(root: string, rel: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string | null> {
  return (await readNoFollow(root, rel, maxBytes))?.toString('utf8') ?? null;
}

export function readTextNoFollowSync(root: string, rel: string, maxBytes = DEFAULT_MAX_BYTES): string | null {
  return readNoFollowSync(root, rel, maxBytes)?.toString('utf8') ?? null;
}

const refused = (rel: string) => new Error(`Refusing to write "${rel}": it leaves the workspace or passes through a symlink`);

/** Writes a file inside `root`, creating missing parent directories. Throws if the path escapes the root or crosses a symlink. */
export async function writeTextNoFollow(root: string, rel: string, content: string): Promise<void> {
  const full = await resolveInside(root, rel);
  if (!full) throw refused(rel);
  await mkdir(path.dirname(full), { recursive: true });
  if ((await resolveInside(root, rel)) !== full) throw refused(rel); // re-check after mkdir
  const handle = await open(full, WRITE_FLAGS, 0o644);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

export function writeTextNoFollowSync(root: string, rel: string, content: string): void {
  const full = resolveInsideSync(root, rel);
  if (!full) throw refused(rel);
  mkdirSync(path.dirname(full), { recursive: true });
  if (resolveInsideSync(root, rel) !== full) throw refused(rel);
  const fd = openSync(full, WRITE_FLAGS, 0o644);
  try {
    const data = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written);
  } finally {
    closeSync(fd);
  }
}
