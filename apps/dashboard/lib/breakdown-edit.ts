import type { SubtaskDraft } from '@sdlc/shared';

/** A subtask as typed in the editor: list fields are text (one per line, or comma separated). */
export interface EditItem {
  seq: number;
  title: string;
  description: string;
  criteria: string;
  files: string;
  dependsOn: string;
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** "1, 2" -> [1, 2]. Anything that is not a whole number stays NaN, so the shared validator reports it. */
export function parseDeps(text: string): number[] {
  return text.split(/[,\s]+/).filter(Boolean).map((t) => (/^\d+$/.test(t) ? Number(t) : Number.NaN));
}

export function toEditItems(drafts: readonly SubtaskDraft[]): EditItem[] {
  return drafts.map((d) => ({ seq: d.seq, title: d.title, description: d.description, criteria: d.acceptanceCriteria.join('\n'), files: d.files.join('\n'), dependsOn: d.dependsOn.join(', ') }));
}

/** The editor's items as the plain list the validator and the API expect. */
export function toDrafts(items: readonly EditItem[]): unknown[] {
  return items.map((i) => ({ seq: i.seq, title: i.title, description: i.description, acceptanceCriteria: lines(i.criteria), files: lines(i.files), dependsOn: parseDeps(i.dependsOn) }));
}

/** Renumbers items to 1..n in their current order and rewrites dependencies through `mapping` (old seq -> new seq). */
function renumber(items: readonly EditItem[], mapping: Map<number, number | null>): EditItem[] {
  return items.map((item, index) => ({
    ...item,
    seq: index + 1,
    dependsOn: parseDeps(item.dependsOn)
      .map((d) => (Number.isNaN(d) ? d : mapping.get(d)))
      .filter((d): d is number => d !== null && d !== undefined)
      .join(', '),
  }));
}

/** Moves one item up (-1) or down (+1). seq values are renumbered and dependencies follow the moved items. */
export function moveItem(items: readonly EditItem[], index: number, delta: -1 | 1): EditItem[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target] as EditItem, next[index] as EditItem];
  const mapping = new Map<number, number | null>();
  next.forEach((item, i) => mapping.set(item.seq, i + 1));
  return renumber(next, mapping);
}

/** Removes one item; the rest are renumbered and dependencies on the removed item are dropped. */
export function removeItem(items: readonly EditItem[], index: number): EditItem[] {
  const removed = items[index]?.seq;
  const next = items.filter((_, i) => i !== index);
  const mapping = new Map<number, number | null>();
  let n = 0;
  for (const item of items) mapping.set(item.seq, item.seq === removed ? null : ++n);
  return renumber(next, mapping);
}

export function addItem(items: readonly EditItem[]): EditItem[] {
  return [...items, { seq: items.length + 1, title: '', description: '', criteria: '', files: '', dependsOn: items.length > 0 ? String(items.length) : '' }];
}
