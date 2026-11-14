import type { HoldInfo } from './types';

export type HoldAction = 'resume' | 'retry' | 'redo-tests';

export interface Guidance {
  /** One line: what state the ticket is in. */
  title: string;
  /** What happened, in plain words. */
  happened: string;
  /** The exact reason the pipeline recorded (shown quoted). */
  detail: string | null;
  /** What to do, in order. */
  steps: string[];
  /** The buttons that apply, each with what it does. The first is the recommended one. */
  actions: { id: HoldAction; label: string; description: string }[];
  /** Links to where the person needs to look or act. */
  links: { href: string; text: string }[];
}

const ACTION: Record<HoldAction, { label: string; description: string }> = {
  resume: { label: 'Resume', description: 'Carry on where the ticket stopped, with its counters as they are.' },
  retry: { label: 'Retry', description: 'Run the stage that was in progress again from a fresh start (fix rounds are reset).' },
  'redo-tests': { label: 'Redo tests', description: 'Discard this subtask’s tests and code and write the tests again, with the failure as context.' },
};

const pick = (...ids: HoldAction[]) => ids.map((id) => ({ id, ...ACTION[id] }));

/** The stage names people see. */
const STAGE: Record<string, string> = { kbBuild: 'knowledge-base build', kbUpdate: 'knowledge-base update', ciFix: 'CI fix', jiraRead: 'Jira read', jiraSync: 'Jira sync' };
const stageName = (s: string) => STAGE[s] ?? s;

/** Explains a held or failed ticket and says what to do about it. Pure: everything comes from the server's hold info. */
export function holdGuidance(info: HoldInfo): Guidance {
  const run = info.failedRun;
  const runLink = run ? [{ href: `/runs/${run.id}`, text: `Open the log of the failed ${stageName(run.stage)} run` }] : [];

  if (info.status === 'FAILED') {
    return {
      title: 'Failed',
      happened: 'The pipeline hit an unexpected internal error on this ticket and stopped.',
      detail: info.note,
      steps: [
        'Read the reason below, and the log of the last run if there is one.',
        'If the cause was outside the code (a token or repository access, Docker, a full disk), fix that.',
        'Press Retry to run the last step again.',
      ],
      actions: pick('retry', ...(info.canRedoTests ? (['redo-tests'] as const) : [])),
      links: runLink,
    };
  }

  switch (info.holdReason) {
    case 'awaiting_answer':
      return {
        title: 'Waiting for your answer',
        happened: 'An agent needs a decision from you before it can continue.',
        detail: info.note,
        steps: ['Open the Inbox and answer the question. The ticket carries on by itself once you answer.'],
        actions: [],
        links: [{ href: '/inbox', text: 'Go to Inbox' }],
      };
    case 'manual':
      return {
        title: 'Paused by you',
        happened: 'This ticket was put on hold from the dashboard. Nothing runs for it while it is on hold.',
        detail: null,
        steps: ['Press Resume when you want it to continue.'],
        actions: pick('resume'),
        links: [],
      };
    case 'pr_closed':
      return {
        title: 'Pull request closed',
        happened: 'The pull request was closed on GitHub without being merged, so the pipeline stopped.',
        detail: info.note,
        steps: [
          'Decide whether the work should still ship. If so, reopen the pull request on GitHub (or open a new one from the ticket’s branch).',
          'Press Resume to continue, or Retry to run the last stage again.',
          'If the work is no longer wanted, leave the ticket on hold.',
        ],
        actions: pick('resume', 'retry'),
        links: [],
      };
    default: {
      // needs_help: a stage failed twice, or reported that it is blocked.
      const where = info.subtask ? ` on subtask ${info.subtask.seq} (“${info.subtask.title}”)` : '';
      const stage = run ? stageName(run.stage) : null;
      const happened = stage
        ? `The ${stage} stage${where} could not finish${run && run.attempt > 1 ? ` after ${run.attempt} attempts` : ''}, so the pipeline stopped and is waiting for you.`
        : `The pipeline got stuck${where} and is waiting for you.`;
      const steps = ['Read the reason below and, for more detail, the log of the failed run.'];
      const actions: HoldAction[] = [];
      if (info.canRedoTests) {
        steps.push(
          'If the problem is a test that is wrong or too strict (for example the agent says it cannot edit tests, or asks you to choose between changing the test and the code), press Redo tests. It discards this subtask’s tests and code and writes the tests again, using this failure and your note as context.',
        );
        actions.push('redo-tests');
      }
      steps.push('If the cause was outside the code (a token or repository access, Docker, a usage limit), fix that first, then press Retry. The stage runs again from a fresh start.');
      actions.push('retry');
      steps.push('Press Resume only if you changed something yourself and want to continue without resetting the counters.');
      actions.push('resume');
      return {
        title: 'Needs your help',
        happened,
        detail: info.note ?? run?.error ?? null,
        steps,
        actions: actions.map((id) => ({ id, ...ACTION[id] })),
        links: runLink,
      };
    }
  }
}
