import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { AGENT_LABEL } from '../agent-runner/container-options';
import { CONTAINER_ENGINE, type ContainerEngine } from '../agent-runner/container-engine';

export interface RecoveryResult {
  /** StageRuns that were `running` when the previous worker died. */
  interrupted: number;
  containersRemoved: number;
  /** Tickets put on hold because the same stage was interrupted by a restart more than once. */
  held: number;
}

/** A stage is re-queued once after a worker restart; a second interruption of the same stage puts the ticket on hold. */
export const MAX_RESTART_REQUEUES = 1;

/**
 * Startup recovery (F4, BUILD_PLAN 6.8): mark runs that were `running` as failed (`worker_restart`), remove leftover
 * agent containers, and let the ticket's stage run again. A re-run starts at attempt 1, so it is not counted as an attempt.
 */
@Injectable()
export class RestartRecovery {
  private readonly logger = new Logger(RestartRecovery.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
  ) {}

  async recover(): Promise<RecoveryResult> {
    const containersRemoved = await this.engine.removeByLabel(AGENT_LABEL).catch((err: unknown) => {
      this.logger.warn(`Could not remove leftover agent containers: ${String(err)}`);
      return 0;
    });

    const running = await this.prisma.stageRun.findMany({ where: { status: 'running' } });
    let held = 0;
    for (const run of running) {
      await this.prisma.stageRun.update({ where: { id: run.id }, data: { status: 'failed', endedAt: new Date(), error: 'worker_restart' } });
      if (!run.ticketId) continue; // a project-level stage (jiraIntake) simply runs again at its next poll

      const earlier = await this.prisma.stageRun.count({ where: { ticketId: run.ticketId, stage: run.stage, error: 'worker_restart', id: { not: run.id } } });
      if (earlier >= MAX_RESTART_REQUEUES) {
        await this.states.hold(run.ticketId, 'needs_help', 'system', `The ${run.stage} stage was interrupted by a worker restart more than once`, run.id).catch((err: unknown) => this.logger.warn(String(err)));
        held++;
      } else {
        await this.prisma.event.create({ data: { ticketId: run.ticketId, type: 'stage', message: `The ${run.stage} stage was interrupted by a worker restart and will run again` } });
      }
    }
    if (running.length > 0 || containersRemoved > 0) this.logger.warn(`Restart recovery: ${running.length} interrupted run(s), ${containersRemoved} leftover container(s) removed, ${held} ticket(s) held`);
    return { interrupted: running.length, containersRemoved, held };
  }
}
