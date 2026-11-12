import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** `<kbDir>/features.json` (BUILD_PLAN 6.9). */
export const KbEntrySchema = z.object({
  key: z.string().min(1),
  title: z.string().default(''),
  doc: z.string().min(1),
  globs: z.array(z.string()).default([]),
  builtFromCommit: z.string().optional(),
  updatedAt: z.string().optional(),
});
export const KbIndexSchema = z.object({ version: z.literal(1).default(1), features: z.array(KbEntrySchema).default([]) });

export type KbEntry = z.infer<typeof KbEntrySchema>;
export type KbIndex = z.infer<typeof KbIndexSchema>;

export const INDEX_FILE = 'features.json';

/** Feature keys name KB docs. */
export const FEATURE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The ticket's feature key (F6): the pasted field, or a Jira label `feature:<key>`.
 * Returns null when there is none or it is not a valid key.
 */
export function featureKeyOf(ticket: { featureKey?: string | null; labels?: unknown }): string | null {
  const direct = ticket.featureKey?.trim().toLowerCase();
  if (direct && FEATURE_KEY.test(direct)) return direct;
  const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const m = /^feature:(.+)$/i.exec(label.trim());
    const key = m?.[1]?.trim().toLowerCase();
    if (key && FEATURE_KEY.test(key)) return key;
  }
  return null;
}

/** Resolves a doc name inside the KB directory. Anything that escapes it, or is not markdown, is rejected. */
export function safeDocPath(workspace: string, kbDir: string, doc: string): string | null {
  if (doc.includes('\0') || path.isAbsolute(doc) || !doc.endsWith('.md')) return null;
  const root = path.resolve(workspace, kbDir);
  const full = path.resolve(root, doc);
  return full.startsWith(root + path.sep) ? full : null;
}

export interface LoadedIndex {
  index: KbIndex;
  /** Set when the file exists but could not be used; the index is then treated as empty. */
  warning?: string;
}

/** A missing directory or index is an empty index (F6). A corrupt one is also treated as empty, with a warning. */
export async function readIndex(workspace: string, kbDir: string): Promise<LoadedIndex> {
  const file = path.resolve(workspace, kbDir, INDEX_FILE);
  if (!existsSync(file)) return { index: { version: 1, features: [] } };
  try {
    return { index: KbIndexSchema.parse(JSON.parse(await readFile(file, 'utf8'))) };
  } catch (err) {
    return { index: { version: 1, features: [] }, warning: `${kbDir}/${INDEX_FILE} is not a valid KB index (${err instanceof Error ? err.message.split('\n')[0] : 'unreadable'}); treating it as empty` };
  }
}

export interface KbMatch {
  entry: KbEntry;
  /** Doc path relative to the workspace root. */
  relPath: string;
  content: string;
}

/** Matches a feature key to an index entry whose doc file exists (F6). */
export async function lookup(workspace: string, kbDir: string, featureKey: string | null): Promise<{ match: KbMatch | null; warning?: string }> {
  const { index, warning } = await readIndex(workspace, kbDir);
  if (!featureKey) return { match: null, warning };
  const entry = index.features.find((f) => f.key === featureKey);
  if (!entry) return { match: null, warning };
  const full = safeDocPath(workspace, kbDir, entry.doc);
  if (!full || !existsSync(full)) return { match: null, warning };
  return { match: { entry, relPath: path.relative(workspace, full), content: await readFile(full, 'utf8') }, warning };
}

/** Adds or updates one entry and writes the index back, sorted by key. */
export async function upsertEntry(workspace: string, kbDir: string, entry: KbEntry): Promise<void> {
  const { index } = await readIndex(workspace, kbDir);
  const features = [...index.features.filter((f) => f.key !== entry.key), entry].sort((a, b) => a.key.localeCompare(b.key));
  const file = path.resolve(workspace, kbDir, INDEX_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, features }, null, 2)}\n`, 'utf8');
}
