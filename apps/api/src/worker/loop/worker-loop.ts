import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ACTIONABLE_STATUSES, type TicketStatus } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { ApprovalPoller } from '../../jira/approval-poller';
import { JiraUnavailableError } from '../../jira/jira-client';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { MirrorService } from '../git/mirror.service';
import { IntakePoller } from '../intake/intake-poller';
import { STEP_HANDLERS, type StepHandler, type StepOutcome } from '../pipeline/step-handler';
import { Schedule } from './schedule';

/** A recurring part of housekeeping, run when its interval has passed (CI checks, PR state; BUILD_PLAN 6.6 step 1). */
export interface Housekeeper {
  readonly name: string;
  readonly intervalMs: number | ((pollIntervalSec: number) => number);
  check(): Promise<void>;
}
export const HOUSEKEEPERS = Symbol('HOUSEKEEPERS');

/** Sleep between iterations when there is nothing to do or the pipeline is paused (BUILD_PLAN 6.6). */
export const IDLE_MS = 5000;

export type TickOutcome =
  | 'busy' // another iteration is still running (this one did nothing)
  | 'paused' // pipelinePaused: housekeeping ran, no step
  | 'blocked' // a stage is already running system-wide
  | 'idle' // no actionable ticket
  | 'stepped'; // one step was run for one ticket

/**
 * One process, one iteration at a time (BUILD_PLAN 6.6): housekeeping when due, pause check, pick the oldest
 * actionable ticket, run exactly one step, apply the resulting transition.
 */
@Injectable()
export class WorkerLoop {
  private readonly logger = new Logger(WorkerLoop.name);
  private readonly schedule: Schedule;
  private running = false;
  private stopped = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mirrors: MirrorService,
    private readonly intake: IntakePoller,
    private readonly approvals: ApprovalPoller,
    private readonly states: StateMachine,
    @Optional() @Inject(STEP_HANDLERS) private readonly handlers: StepHandler[] = [],
    private readonly now: () => number = () => Date.now(),
    @Optional() @Inject(HOUSEKEEPERS) private readonly housekeepers: Housekeeper[] = [],
    @Optional() private readonly holds?: { onHold(ticketId: string, reason: string, note?: string): Promise<void> },
  ) {
    this.schedule = new Schedule(now);
  }

  /** One iteration. Never throws: a failed iteration is logged and the loop carries on. */
  async tick(): Promise<TickOutcome> {
    if (this.running) return 'busy';
    this.running = true;
    try {
      await this.cloneMirrors();
      await this.housekeeping();

      const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
      if (settings?.pipelinePaused) return 'paused';

      // At most one StageRun runs at any time, system-wide (F4).
      if ((await this.prisma.stageRun.count({ where: { status: 'running' } })) > 0) return 'blocked';

      const ticket = await this.pickNext();
      if (!ticket) return 'idle';
      const outcome = await this.runStep(ticket);
      return outcome === 'stay' ? 'idle' : 'stepped';
    } catch (err) {
      this.logger.error(`Worker iteration failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return 'idle';
    } finally {
      this.running = false;
    }
  }

  /** Oldest actionable ticket that has a handler (BUILD_PLAN 6.6 step 3), or null. */
  async pickNext(): Promise<Ticket | null> {
    const handled = new Set(this.handlers.map((h) => h.status));
    const statuses = ACTIONABLE_STATUSES.filter((s) => handled.has(s));
    const where = {
      project: { enabled: true },
      OR: [
        ...(statuses.length > 0 ? [{ status: { in: statuses as TicketStatus[] } }] : []),
        // A ticket waiting for CI is only picked when a CI fix is pending.
        ...(handled.has('AWAITING_CI') ? [{ status: 'AWAITING_CI' as const, ciFixPending: true }] : []),
        // A ticket in human review is only picked when a KB-update re-run was requested.
        ...(handled.has('IN_HUMAN_REVIEW') ? [{ status: 'IN_HUMAN_REVIEW' as const, kbUpdatePending: true }] : []),
      ],
    };
    if (where.OR.length === 0) return null;
    return this.prisma.ticket.findFirst({ where, orderBy: { createdAt: 'asc' } });
  }

  private async runStep(ticket: Ticket): Promise<StepOutcome['kind'] | 'failed'> {
    const handler = this.handlers.find((h) => h.status === ticket.status);
    if (!handler) return 'stay';
    let outcome: StepOutcome;
    try {
      outcome = await handler.run(ticket);
    } catch (err) {
      // An unexpected error in a step is an unrecoverable internal error (6.6 row 18).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Step for ${ticket.key} in ${ticket.status} failed: ${message}`);
      await this.states.fail(ticket.id, message.slice(0, 500)).catch((e: unknown) => this.logger.error(String(e)));
      return 'failed';
    }
    switch (outcome.kind) {
      case 'transition':
        await this.states.transition(ticket.id, outcome.to, 'system', outcome.reason, outcome.stageRunId);
        break;
      case 'hold':
        await this.states.hold(ticket.id, outcome.reason, 'system', outcome.note, outcome.stageRunId);
        await this.holds?.onHold(ticket.id, outcome.reason, outcome.note).catch((e: unknown) => this.logger.warn(`Hold notice failed: ${String(e)}`));
        break;
      case 'continue':
      case 'stay':
        break;
    }
    return outcome.kind;
  }

  private cloneMirrors = async () => {
    const pending = await this.prisma.project.findMany({ where: { mirrorStatus: 'pending', enabled: true }, orderBy: { createdAt: 'asc' } });
    for (const project of pending) await this.mirrors.clone(project);
  };

  /** Each part runs only when due (BUILD_PLAN 6.6 step 1). CI checks, PR state and cleanup are added with their milestones. */
  private async housekeeping(): Promise<void> {
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const pollSec = settings?.pollIntervalSec ?? 120;
    const intervalMs = pollSec * 1000;
    for (const h of this.housekeepers) {
      if (!this.schedule.due(h.name, typeof h.intervalMs === 'function' ? h.intervalMs(pollSec) * 1000 : h.intervalMs)) continue;
      await h.check().catch((err: unknown) => this.logger.error(`${h.name} check failed: ${String(err)}`));
    }
    if (!this.schedule.due('jira', intervalMs)) return;

    // The intake poller applies the intake-pause switch and its own Jira backoff.
    await this.intake.poll().catch((err: unknown) => this.logger.error(`Intake poll failed: ${String(err)}`));
    if (settings?.intakePaused) return;
    try {
      await this.approvals.check();
    } catch (err) {
      if (err instanceof JiraUnavailableError) this.logger.warn(`Approval check skipped: ${err.message}`);
      else this.logger.error(`Approval check failed: ${String(err)}`);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const outcome = await this.tick();
      // After a step the next iteration starts straight away; otherwise wait (never inside a step).
      if (outcome !== 'stepped') await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    }
  }
}
