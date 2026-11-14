/**
 * A small line diff, enough to show what a rewrite changed (BUILD_PLAN v1 6.6). Lines only in the old text start with "- ",
 * lines only in the new text with "+ ". Order inside each group follows the text. Returns "(no change)" when equal.
 */
export function planDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const inB = new Set(b);
  const inA = new Set(a);
  const out = [...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`)];
  return out.length > 0 ? out.join('\n') : '(no change)';
}
