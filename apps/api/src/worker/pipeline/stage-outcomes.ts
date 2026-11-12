import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { StageResult } from '../agent-runner/agent-runner';
import type { StepOutcome } from './step-handler';

/** F13: the 4th question of a stage holds the ticket for help instead. */
export const MAX_QUESTIONS_PER_STAGE = 3;

export type NonDoneResult = Exclude<StageResult, { kind: 'done' }>;

/**
 * What a ticket does when a stage did not simply succeed (BUILD_PLAN 6.8). `done` is the stage's own business;
 * everything else is the same for every stage, so it lives here.
 */
@Injectable()
export class StageOutcomes {
  constructor(private readonly prisma: PrismaService) {}

  async forResult(ticketId: string, stage: string, result: NonDoneResult): Promise<StepOutcome> {
    switch (result.kind) {
      case 'needs_input':
        // The stage asks the developer something: store the question and wait for the answer. A stage may ask at most 3 questions per ticket (F13).
        if ((await this.prisma.supportQuery.count({ where: { ticketId, stage } })) >= MAX_QUESTIONS_PER_STAGE) {
          return { kind: 'hold', reason: 'needs_help', note: `The ${stage} stage asked more than ${MAX_QUESTIONS_PER_STAGE} questions: ${result.question}`.slice(0, 500), stageRunId: result.stageRunId };
        }
        await this.prisma.supportQuery.create({ data: { ticketId, stageRunId: result.stageRunId, stage, question: result.question } });
        return { kind: 'hold', reason: 'awaiting_answer', note: result.question.slice(0, 200), stageRunId: result.stageRunId };
      case 'failed':
        return { kind: 'hold', reason: 'needs_help', note: `The ${stage} stage failed twice: ${result.reason}`.slice(0, 500), stageRunId: result.stageRunId };
      case 'turn_limit':
        return { kind: 'hold', reason: 'needs_help', note: `The ${stage} stage reached its turn limit`, stageRunId: result.stageRunId };
      case 'killed':
        return { kind: 'hold', reason: 'manual', note: `The ${stage} stage was killed from the dashboard`, stageRunId: result.stageRunId };
      case 'rate_limited': {
        // The usage gate treats a rate-limit error as `rejected` and has paused the pipeline (6.7); the stage is re-queued, not counted as an
        // attempt. If the gate was not running (tests, or it failed), make sure the pause is in place.
        const current = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
        if (!current?.pipelinePaused) {
          await this.prisma.globalSettings.upsert({
            where: { id: 'global' },
            update: { pipelinePaused: true, pausedReason: 'Claude rejected the request: the usage limit is reached', resetsAt: result.resetsAt },
            create: { id: 'global', pipelinePaused: true, pausedReason: 'Claude rejected the request: the usage limit is reached', resetsAt: result.resetsAt },
          });
        }
        await this.prisma.event.create({ data: { ticketId, type: 'usage', message: `The ${stage} stage was rate limited: the pipeline is paused` } });
        return { kind: 'stay' };
      }
    }
  }
}
