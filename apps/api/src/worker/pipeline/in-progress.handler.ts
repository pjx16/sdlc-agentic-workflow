import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, nextSubtask, stepFor, type SubtaskStep } from '@sdlc/shared';
import type { Subtask, Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { StepHandler, StepOutcome } from './step-handler';

/** The five things that can happen to a subtask in one loop iteration (BUILD_PLAN 6.6, F9). Each returns the step's outcome. */
export interface SubtaskSteps {
  tests(ticket: Ticket, subtask: Subtask): Promise<StepOutcome>;
  verifyRed(ticket: Ticket, subtask: Subtask): Promise<StepOutcome>;
  implement(ticket: Ticket, subtask: Subtask): Promise<StepOutcome>;
  verifyGreen(ticket: Ticket, subtask: Subtask): Promise<StepOutcome>;
  fix(ticket: Ticket, subtask: Subtask): Promise<StepOutcome>;
  /** Called once when every subtask is DONE, before the ticket moves on (for example to open the PR when it opens last). */
  allDone?(ticket: Ticket): Promise<StepOutcome | void>;
}

export const SUBTASK_STEPS = Symbol('SUBTASK_STEPS');

/**
 * IN_PROGRESS (row 11): subtasks are processed in order, one step per loop iteration. When every subtask is DONE the
 * ticket moves to REVIEW (or straight to KB_UPDATE when the review stage is off).
 */
@Injectable()
export class InProgressHandler implements StepHandler {
  readonly status = 'IN_PROGRESS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly steps: SubtaskSteps,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const subtasks = await this.prisma.subtask.findMany({ where: { ticketId: ticket.id }, orderBy: { seq: 'asc' } });
    if (subtasks.length === 0) return { kind: 'hold', reason: 'needs_help', note: 'The ticket is in progress but has no subtasks' };

    const next = nextSubtask(subtasks);
    if (!next) {
      const extra = await this.steps.allDone?.(ticket);
      if (extra && extra.kind !== 'continue') return extra;
      return settings.stages.review.enabled
        ? { kind: 'transition', to: 'REVIEW', reason: 'Every subtask is done' }
        : { kind: 'transition', to: 'KB_UPDATE', reason: 'Every subtask is done; the review stage is off' };
    }

    const step = stepFor(next.status, { testsEnabled: settings.stages.tests.enabled }) as SubtaskStep;
    switch (step) {
      case 'tests':
        return this.steps.tests(ticket, next);
      case 'verify_red':
        return this.steps.verifyRed(ticket, next);
      case 'implement':
        return this.steps.implement(ticket, next);
      case 'verify_green':
        return this.steps.verifyGreen(ticket, next);
      case 'fix':
        return this.steps.fix(ticket, next);
    }
  }
}
