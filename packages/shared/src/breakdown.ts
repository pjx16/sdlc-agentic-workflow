import { z } from 'zod';

/** One proposed subtask (BUILD_PLAN 6.5, F8). */
export const SubtaskDraftSchema = z.object({
  seq: z.number({ error: 'must be a number' }).int('must be a whole number').min(1, 'must be at least 1'),
  title: z.string({ error: 'required' }).trim().min(1, 'required').max(200, 'must be at most 200 characters'),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string().trim().min(1, 'must not be empty')).min(1, 'at least one acceptance criterion'),
  files: z.array(z.string().trim().min(1, 'must not be empty')).default([]),
  dependsOn: z.array(z.number().int().min(1)).default([]),
});
export type SubtaskDraft = z.infer<typeof SubtaskDraftSchema>;

export const DEFAULT_MAX_SUBTASKS = 8;

export interface BreakdownIssue {
  /** Dotted path for field-level display, for example `subtasks.2.dependsOn`. */
  field: string;
  message: string;
}

export type BreakdownVerdict = { ok: true; subtasks: SubtaskDraft[] } | { ok: false; issues: BreakdownIssue[] };

/** Finds a dependency cycle (as a list of seq values) in `seq -> dependsOn`, or null. Ignores unknown seq values. */
export function findCycle(subtasks: readonly Pick<SubtaskDraft, 'seq' | 'dependsOn'>[]): number[] | null {
  const deps = new Map(subtasks.map((s) => [s.seq, s.dependsOn]));
  const state = new Map<number, 'visiting' | 'done'>();
  const stack: number[] = [];
  const visit = (seq: number): number[] | null => {
    if (state.get(seq) === 'done') return null;
    if (state.get(seq) === 'visiting') return [...stack.slice(stack.indexOf(seq)), seq];
    state.set(seq, 'visiting');
    stack.push(seq);
    for (const d of deps.get(seq) ?? []) {
      if (!deps.has(d)) continue;
      const cycle = visit(d);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(seq, 'done');
    return null;
  };
  for (const seq of deps.keys()) {
    const cycle = visit(seq);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * The orchestrator's rules for a breakdown (F8): at least one subtask and at most `maxSubtasks`; `seq` values are exactly
 * 1..n; `dependsOn` never refers to the same or a later `seq` (so there is no cycle); every subtask has a title and at
 * least one acceptance criterion. A rejected output counts as a failed attempt. The same rules apply to dashboard edits.
 */
export function validateBreakdown(input: unknown, opts: { maxSubtasks?: number } = {}): BreakdownVerdict {
  const max = opts.maxSubtasks ?? DEFAULT_MAX_SUBTASKS;
  const issues: BreakdownIssue[] = [];
  if (!Array.isArray(input)) return { ok: false, issues: [{ field: 'subtasks', message: 'must be a list of subtasks' }] };
  if (input.length === 0) return { ok: false, issues: [{ field: 'subtasks', message: 'at least one subtask is required' }] };
  if (input.length > max) issues.push({ field: 'subtasks', message: `${input.length} subtasks is more than the limit of ${max}` });

  const parsed: SubtaskDraft[] = [];
  input.forEach((raw, i) => {
    const r = SubtaskDraftSchema.safeParse(raw);
    if (r.success) parsed.push(r.data);
    else for (const issue of r.error.issues) issues.push({ field: `subtasks.${i}.${issue.path.join('.')}`.replace(/\.$/, ''), message: issue.message });
  });
  if (parsed.length !== input.length) return { ok: false, issues };

  const sorted = [...parsed].sort((a, b) => a.seq - b.seq);
  const expected = sorted.map((_, i) => i + 1);
  if (sorted.some((s, i) => s.seq !== expected[i])) {
    issues.push({ field: 'subtasks', message: `seq values must be exactly 1 to ${parsed.length} with no gaps or duplicates (got ${sorted.map((s) => s.seq).join(', ')})` });
  }

  parsed.forEach((s, i) => {
    for (const d of s.dependsOn) {
      if (d === s.seq) issues.push({ field: `subtasks.${i}.dependsOn`, message: `subtask ${s.seq} cannot depend on itself` });
      else if (d > s.seq) issues.push({ field: `subtasks.${i}.dependsOn`, message: `subtask ${s.seq} depends on a later subtask (${d}); dependencies must point to earlier ones` });
      else if (!parsed.some((p) => p.seq === d)) issues.push({ field: `subtasks.${i}.dependsOn`, message: `subtask ${s.seq} depends on ${d}, which does not exist` });
    }
    if (new Set(s.dependsOn).size !== s.dependsOn.length) issues.push({ field: `subtasks.${i}.dependsOn`, message: 'lists the same dependency more than once' });
  });
  // Self-dependencies already have their own message, so they are left out of the cycle check.
  const cycle = findCycle(parsed.map((s) => ({ seq: s.seq, dependsOn: s.dependsOn.filter((d) => d !== s.seq) })));
  if (cycle) issues.push({ field: 'subtasks', message: `dependency cycle: ${cycle.join(' -> ')}` });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, subtasks: sorted };
}

/** The message for a failed attempt (BUILD_PLAN 6.8). */
export const describeIssues = (issues: readonly BreakdownIssue[]): string => issues.map((i) => `${i.field}: ${i.message}`).join('; ');

export const DEFAULT_CRITERION = 'The change described in the ticket is implemented and tested';

/**
 * With `breakdown` off the ticket runs as one subtask whose description is the plan (F2). Acceptance criteria come from an
 * "Acceptance criteria" section of the ticket body when there is one, otherwise a single default criterion.
 */
export function acceptanceCriteriaFrom(body: string): string[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\s{0,3}(#{1,6}\s*)?\**acceptance criteria\**\s*:?\s*\**\s*$/i.test(l));
  if (start < 0) return [DEFAULT_CRITERION];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) break; // the next heading ends the section
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    if (item) found.push((item[1] as string).replace(/^\[[ xX]\]\s*/, '').trim());
    else if (line.trim() === '' || found.length === 0) continue;
    else if (!/^\s{2,}/.test(line)) break; // plain text after the list ends it (indented lines continue an item)
  }
  return found.length > 0 ? found : [DEFAULT_CRITERION];
}

export function singleSubtask(ticket: { title: string; body: string }, plan: string): SubtaskDraft {
  return { seq: 1, title: ticket.title.slice(0, 200), description: plan, acceptanceCriteria: acceptanceCriteriaFrom(ticket.body), files: [], dependsOn: [] };
}
