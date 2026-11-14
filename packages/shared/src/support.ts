/** Support tickets: everything that needs a person (BUILD_PLAN v1 6.5). */

export const SUPPORT_KINDS = ['approval', 'question', 'open_question', 'hold', 'ci_infra', 'onboarding', 'credential', 'pr_ready'] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

export const SUPPORT_PRIORITIES = ['blocking', 'normal', 'fyi'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_STATUSES = ['open', 'answered', 'resolved', 'dismissed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** The pipeline waits for these: they get a Jira comment and, with a PR, a PR comment. */
export const BLOCKING_BY_DEFAULT: readonly SupportKind[] = ['approval', 'question', 'hold', 'ci_infra', 'onboarding', 'credential'];

export const defaultPriority = (kind: SupportKind): SupportPriority => (BLOCKING_BY_DEFAULT.includes(kind) ? 'blocking' : kind === 'pr_ready' ? 'fyi' : 'normal');

/** Where the inbox shows a ticket. The kind decides first, so an approval is one item under Approvals, not two. */
export type InboxGroup = 'approvals' | 'questions' | 'blocking' | 'fyi';

export function inboxGroup(t: { kind: SupportKind; priority: SupportPriority }): InboxGroup {
  if (t.kind === 'approval') return 'approvals';
  if (t.kind === 'question' || t.kind === 'open_question') return 'questions';
  if (t.priority === 'fyi') return 'fyi';
  return 'blocking';
}

export const INBOX_GROUP_LABEL: Record<InboxGroup, string> = { blocking: 'Blocking', approvals: 'Approvals', questions: 'Questions', fyi: 'FYI' };
export const INBOX_GROUPS: readonly InboxGroup[] = ['blocking', 'approvals', 'questions', 'fyi'];

/** What the sidebar badge counts: blocking and approval items that are still open. */
export const countsForBadge = (t: { kind: SupportKind; priority: SupportPriority; status: SupportStatus }): boolean =>
  t.status === 'open' && (t.kind === 'approval' || t.priority === 'blocking');

/** The actions a person can take on a ticket of this kind (BUILD_PLAN v1 6.5 table). */
export type SupportAction = 'approve' | 'reject' | 'answer' | 'rerun_with_answers' | 'resume' | 'retry' | 'fail' | 'fixed' | 'hold' | 'dismiss';

export const SUPPORT_ACTIONS: Record<SupportKind, readonly SupportAction[]> = {
  approval: ['approve', 'reject', 'dismiss'],
  question: ['answer', 'dismiss'],
  open_question: ['answer', 'rerun_with_answers', 'dismiss'],
  hold: ['resume', 'retry', 'fail', 'dismiss'],
  ci_infra: ['fixed', 'hold', 'dismiss'],
  onboarding: ['dismiss'],
  credential: ['dismiss'],
  pr_ready: ['dismiss'],
};
