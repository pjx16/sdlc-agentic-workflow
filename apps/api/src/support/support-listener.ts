import { Injectable } from '@nestjs/common';
import type { TransitionListener, TransitionResult } from '../state/state-machine.service';
import { SupportRaiser } from './support-raiser';

const APPROVALS = ['AWAITING_PLAN_APPROVAL', 'AWAITING_BREAKDOWN_APPROVAL'] as const;

/**
 * Raises and closes the support tickets that follow a ticket's state (BUILD_PLAN v1 6.5): an approval while a plan or
 * breakdown waits at its gate, a hold while the ticket is held or failed, a "PR ready" note while it waits for human review.
 * Because it watches every transition, a ticket is closed whoever moved it: the dashboard, Jira or the worker.
 */
@Injectable()
export class SupportTransitionListener implements TransitionListener {
  constructor(private readonly raiser: SupportRaiser) {}

  async onTransition({ ticket, transition }: TransitionResult): Promise<void> {
    const from = transition.fromStatus;
    const to = transition.toStatus;
    const by = transition.actor;
    const base = { ticketId: ticket.id, projectId: ticket.projectId };

    // Leaving a state closes what that state needed from a person.
    if ((APPROVALS as readonly string[]).includes(from)) await this.raiser.close({ ticketId: ticket.id, kind: 'approval' }, 'resolved', by, transition.reason ?? undefined);
    if (from === 'ON_HOLD' || from === 'FAILED') await this.raiser.close({ ticketId: ticket.id, kind: ['hold', 'ci_infra'] }, 'resolved', by, transition.reason ?? undefined);
    if (from === 'IN_HUMAN_REVIEW') await this.raiser.close({ ticketId: ticket.id, kind: 'pr_ready' }, 'resolved', by, to === 'DONE' ? 'The PR was merged' : (transition.reason ?? undefined));

    if (to === 'AWAITING_PLAN_APPROVAL') {
      await this.raiser.raise({ ...base, kind: 'approval', stage: 'plan', dedupeKey: `approval:${ticket.id}:plan`, title: `Approve the plan for ${ticket.key}`, body: `The plan for **${ticket.key}: ${ticket.title}** is ready and waits for your approval.\n\nApprove it to move on to the breakdown, or reject it with a note to have it redone.` });
    } else if (to === 'AWAITING_BREAKDOWN_APPROVAL') {
      await this.raiser.raise({ ...base, kind: 'approval', stage: 'breakdown', dedupeKey: `approval:${ticket.id}:breakdown`, title: `Approve the breakdown for ${ticket.key}`, body: `The breakdown for **${ticket.key}: ${ticket.title}** is ready and waits for your approval.` });
    } else if (to === 'ON_HOLD' && ticket.holdReason !== 'awaiting_answer' && !(await this.raiser.hasOpen(ticket.id, 'ci_infra'))) {
      // `awaiting_answer` already has its own question ticket, raised by the stage outcome; a CI problem already has its own too.
      await this.raiser.raise({ ...base, kind: 'hold', stage: ticket.holdFromStatus ?? '', dedupeKey: `hold:${ticket.id}`, title: `${ticket.key} is on hold`, body: `**${ticket.key}: ${ticket.title}** is on hold (${ticket.holdReason ?? 'no reason recorded'}).\n\n${transition.reason ?? ''}`.trim() });
    } else if (to === 'FAILED') {
      await this.raiser.raise({ ...base, kind: 'hold', stage: ticket.holdFromStatus ?? '', dedupeKey: `hold:${ticket.id}`, title: `${ticket.key} failed`, body: `**${ticket.key}: ${ticket.title}** failed.\n\n${transition.reason ?? ''}`.trim() });
    } else if (to === 'IN_HUMAN_REVIEW') {
      await this.raiser.raise({ ...base, kind: 'pr_ready', stage: 'review', dedupeKey: `pr_ready:${ticket.id}`, title: `${ticket.key} is ready for human review`, body: `The pull request for **${ticket.key}: ${ticket.title}** is ready.${ticket.prUrl ? `\n\n${ticket.prUrl}` : ''}` });
    }
  }
}
