import { validateBreakdown } from '@sdlc/shared';
import { describe, expect, it } from 'vitest';
import { addItem, moveItem, parseDeps, removeItem, toDrafts, toEditItems, type EditItem } from './breakdown-edit';

const item = (seq: number, over: Partial<EditItem> = {}): EditItem => ({ seq, title: `T${seq}`, description: '', criteria: 'works', files: '', dependsOn: '', ...over });
const summary = (items: EditItem[]) => items.map((i) => `${i.seq}:${i.title}[${i.dependsOn}]`);

describe('breakdown editor helpers', () => {
  it('parses dependency text, keeping non-numbers visible to the validator', () => {
    expect(parseDeps('1, 2  3')).toEqual([1, 2, 3]);
    expect(parseDeps('')).toEqual([]);
    expect(parseDeps('1, x')).toEqual([1, Number.NaN]);
    expect(parseDeps('-1')).toEqual([Number.NaN]);
  });

  it('round-trips a draft through the editor representation', () => {
    const draft = [{ seq: 1, title: 'a', description: 'd', acceptanceCriteria: ['c1', 'c2'], files: ['f1'], dependsOn: [] }, { seq: 2, title: 'b', description: '', acceptanceCriteria: ['c'], files: [], dependsOn: [1] }];
    const items = toEditItems(draft);
    expect(items[0]).toMatchObject({ criteria: 'c1\nc2', files: 'f1', dependsOn: '' });
    expect(items[1]?.dependsOn).toBe('1');
    expect(toDrafts(items)).toEqual(draft);
  });

  it('turns blank lines and spaces into nothing, so an empty criteria box is invalid', () => {
    const drafts = toDrafts([item(1, { criteria: ' \n\n  ' })]);
    expect(validateBreakdown(drafts).ok).toBe(false);
  });

  it('moves an item and renumbers, with dependencies following the moved subtasks', () => {
    // 1, 2 (needs 1), 3 (needs 2). Moving 3 up above 2: new order 1, 3, 2.
    const moved = moveItem([item(1), item(2, { dependsOn: '1' }), item(3, { dependsOn: '2' })], 2, -1);
    expect(summary(moved)).toEqual(['1:T1[]', '2:T3[3]', '3:T2[1]']); // T3 now depends on T2 (seq 3): a forward dependency the validator will flag
    expect(validateBreakdown(toDrafts(moved)).ok).toBe(false);
  });

  it('a harmless move keeps the list valid', () => {
    const moved = moveItem([item(1), item(2), item(3, { dependsOn: '1' })], 1, 1); // swap 2 and 3
    expect(summary(moved)).toEqual(['1:T1[]', '2:T3[1]', '3:T2[]']);
    expect(validateBreakdown(toDrafts(moved)).ok).toBe(true);
  });

  it('does nothing when moving past either end', () => {
    const list = [item(1), item(2)];
    expect(moveItem(list, 0, -1)).toEqual(list);
    expect(moveItem(list, 1, 1)).toEqual(list);
  });

  it('removes an item, renumbers, and drops dependencies on it', () => {
    const next = removeItem([item(1), item(2, { dependsOn: '1' }), item(3, { dependsOn: '1, 2' })], 1);
    expect(summary(next)).toEqual(['1:T1[]', '2:T3[1]']);
    expect(validateBreakdown(toDrafts(next)).ok).toBe(true);
  });

  it('adds a blank subtask that depends on the previous one', () => {
    const next = addItem([item(1), item(2)]);
    expect(next[2]).toMatchObject({ seq: 3, title: '', dependsOn: '2' });
    expect(addItem([])[0]).toMatchObject({ seq: 1, dependsOn: '' });
  });

  it('does not mutate its input', () => {
    const list = [item(1), item(2, { dependsOn: '1' })];
    const copy = JSON.stringify(list);
    moveItem(list, 1, -1);
    removeItem(list, 0);
    addItem(list);
    expect(JSON.stringify(list)).toBe(copy);
  });
});
