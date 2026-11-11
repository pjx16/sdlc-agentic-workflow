import { SEVERITY_ORDER, type StoredFinding } from './review-findings';

const HEADINGS: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** A value inside a markdown table cell: no pipes, no line breaks. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim() || '—';

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
