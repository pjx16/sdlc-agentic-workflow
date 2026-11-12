export interface PrSubtask {
  seq: number;
  title: string;
  featCommit: string | null;
  acceptanceCriteria: string[];
}

export interface PrDescriptionInput {
  ticket: { key: string; title: string; body: string; externalKey: string | null };
  /** Base URL of the Jira site, to link the issue. */
  jiraBaseUrl?: string;
  subtasks: PrSubtask[];
  /** The targeted test command template that was used. */
  testCommand: string;
  /** Counts of the findings that remain open after review (milestone 8). */
  remainingFindings?: { medium: number; low: number };
}

const PROBLEM_CHARS = 600;

/**
 * The PR description (BUILD_PLAN 6.9), assembled by the orchestrator without AI and rewritten when the PR is marked ready.
 * No attribution of any kind appears in it (F9).
 */
export function buildPrDescription(input: PrDescriptionInput): string {
  const { ticket } = input;
  const key = ticket.externalKey && input.jiraBaseUrl ? `${ticket.key} ([link](${input.jiraBaseUrl.replace(/\/+$/, '')}/browse/${ticket.externalKey}))` : ticket.key;
  const body = ticket.body.trim();
  const problem = body.length > PROBLEM_CHARS ? `${body.slice(0, PROBLEM_CHARS - 1).trimEnd()}…` : body || '_No description._';

  const fix = input.subtasks.length > 0 ? input.subtasks.map((s) => `- ${s.title} (${s.featCommit ? `\`${s.featCommit.slice(0, 8)}\`` : 'in progress'})`).join('\n') : '_No subtasks yet._';
  const plan = input.subtasks.length > 0
    ? input.subtasks.map((s) => `**${s.seq}. ${s.title}**\n${s.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`).join('\n\n')
    : '_No acceptance criteria yet._';
  const remaining = input.remainingFindings;
  const review = remaining && remaining.medium + remaining.low > 0 ? `${remaining.medium} medium and ${remaining.low} low finding(s) remain open.` : 'none';

  return [
    `## Summary\n${ticket.title} — ${key}`,
    `## Problem\n${problem}`,
    `## Fix implemented\n${fix}`,
    `## Test plan\n${plan}\n\nTargeted test command: \`${input.testCommand}\``,
    `## Review notes\n${review}`,
  ].join('\n\n') + '\n';
}
