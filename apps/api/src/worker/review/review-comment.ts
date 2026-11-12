import { SEVERITY_ORDER, type StoredFinding } from './review-findings';

const HEADINGS: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** A value inside a markdown table cell: no pipes, no line breaks. Backslashes are escaped first, so `\\|` in the text cannot turn into an unescaped pipe. */
const cell = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim() || '—';

const location = (f: Pick<StoredFinding, 'file' | 'line'>): string => (f.line === null ? `\`${f.file}\`` : `\`${f.file}:${f.line}\``);

export interface ReviewCommentInput {
  round: number;
  summary: string;
  /** The findings reported in this round. */
  findings: readonly Pick<StoredFinding, 'severity' | 'file' | 'line' | 'issue' | 'rule' | 'fix'>[];
  /** Previous findings this round resolved or kept open (round 2 and later). */
  previous?: { fixed: number; stillOpen: number };
}

/** The review comment posted on the PR (BUILD_PLAN 6.9): one table per severity that has findings. */
export function renderReviewComment(input: ReviewCommentInput): string {
  const parts = [`## Review — round ${input.round}`, input.summary.trim() || '_No summary._'];
  const bySeverity = new Map<string, ReviewCommentInput['findings'][number][]>();
  for (const f of input.findings) bySeverity.set(f.severity, [...(bySeverity.get(f.severity) ?? []), f]);
  const severities = [...bySeverity.keys()].sort((a, b) => (SEVERITY_ORDER[a] ?? 9) - (SEVERITY_ORDER[b] ?? 9));

  if (severities.length === 0) parts.push('No findings.');
  for (const sev of severities) {
    const rows = (bySeverity.get(sev) ?? []).map((f) => `| ${cell(f.issue)} | ${location(f)} | ${cell(f.rule)} | ${cell(f.fix)} |`);
    parts.push([`### ${HEADINGS[sev] ?? sev}`, '| Issue | Location | Why it matters | Suggested fix |', '| --- | --- | --- | --- |', ...rows].join('\n'));
  }
  if (input.round > 1 && input.previous) parts.push(`Previous findings: ${input.previous.fixed} fixed, ${input.previous.stillOpen} still open.`);
  return `${parts.join('\n\n')}\n`;
}

/** The open findings as plain text, for the `fix` stage (it works on these only). */
export function renderFindingsForFix(findings: readonly Pick<StoredFinding, 'severity' | 'file' | 'line' | 'issue' | 'rule' | 'fix'>[]): string {
  return findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.file}${f.line === null ? '' : `:${f.line}`}\n   Issue: ${f.issue}\n   Rule: ${f.rule}\n   Suggested fix: ${f.fix}`)
    .join('\n\n');
}

export interface ReviewSummaryInput {
  rounds: number;
  /** Counts by status over every round. */
  fixed: number;
  /** Findings still open after the last round, by severity. */
  open: Record<'critical' | 'high' | 'medium' | 'low', number>;
}

/** The comment posted when the PR is marked ready: how the review went, in a few lines. */
export function renderReviewSummary(input: ReviewSummaryInput): string {
  if (input.rounds === 0) return '## Review summary\n\nThe review stage was not run for this ticket.\n';
  const open = (['critical', 'high', 'medium', 'low'] as const).filter((s) => input.open[s] > 0).map((s) => `${input.open[s]} ${s}`);
  const left = open.length === 0 ? 'No findings remain open.' : `Still open: ${open.join(', ')}.`;
  return `## Review summary\n\n${input.rounds} review round(s); ${input.fixed} finding(s) fixed. ${left}\n\nCI checks passed; this PR is ready for human review.\n`;
}
