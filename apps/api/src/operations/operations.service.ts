import { Injectable } from '@nestjs/common';
import { ACTIONABLE_STATUSES, type TicketStatus } from '@sdlc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { workerState, type WorkerState } from '../system/system-settings.service';
import { DEFAULT_STUCK, failureRates, findStuck, integrationRates, stageLoad, type IntegrationRate, type RunRow, type StageFailure, type StageLoad, type StuckTicket } from './operations-calc';

const HOUR = 3_600_000;

export interface OperationsDto {
  worker: {
    state: WorkerState | 'unknown';
    phase: string | null;
    phaseDetail: string | null;
    phaseSince: string | null;
    uptimeSec: number | null;
    /** Worker starts in the last 24 hours. */
    restarts24h: number;
    /** Tickets in a state the worker acts on, with no run going. */
    queueDepth: number;
  };
  stuck: StuckTicket[];
  failures: { last24h: { byStage: StageFailure[]; byCode: { code: string; count: number }[] }; last7d: { byStage: StageFailure[]; byCode: { code: string; count: number }[] } };
  load: StageLoad[];
  integrations: IntegrationRate[];
  recentErrors: { id: string; at: string; source: string; message: string; errorCode: string | null; ticketId: string | null; ticketKey: string | null }[];
}

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /operations (BUILD_PLAN v1 6.4). `now` is a parameter so tests can fix the clock. */
  async overview(now: Date = new Date(), thresholds = DEFAULT_STUCK): Promise<OperationsDto> {
    const since24h = new Date(now.getTime() - 24 * HOUR);
    const since7d = new Date(now.getTime() - 7 * 24 * HOUR);

    const [worker, settings, runs7d, openTickets, activeRuns, starts, events24h, recent] = await Promise.all([
      this.prisma.workerStatus.findUnique({ where: { id: 'worker' } }),
      this.prisma.globalSettings.findUnique({ where: { id: 'global' } }),
      this.prisma.stageRun.findMany({ where: { startedAt: { gte: since7d } }, select: { stage: true, status: true, attempt: true, round: true, errorCode: true, errorSource: true, startedAt: true, endedAt: true, inputTokens: true, outputTokens: true, costUsd: true } }),
      this.prisma.ticket.findMany({ where: { status: { notIn: ['DONE', 'FAILED'] }, project: { enabled: true } }, select: { id: true, key: true, status: true, updatedAt: true } }),
      this.prisma.stageRun.findMany({ where: { status: { in: ['queued', 'running'] }, ticketId: { not: null } }, select: { ticketId: true } }),
      this.prisma.event.count({ where: { type: 'worker', message: { startsWith: 'Worker started' }, at: { gte: since24h } } }),
      this.prisma.event.findMany({ where: { at: { gte: since24h }, source: { in: ['jira', 'confluence', 'github'] } }, select: { source: true, level: true } }),
      this.prisma.event.findMany({ where: { level: 'error' }, orderBy: { at: 'desc' }, take: 20, include: { ticket: { select: { key: true } } } }),
    ]);

    const rows: (RunRow & { errorSource: string | null })[] = runs7d.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
    const in24h = rows.filter((r) => r.startedAt && r.startedAt >= since24h);
    const active = new Set(activeRuns.map((r) => r.ticketId));
    const tickets = openTickets.map((t) => ({ ...t, status: t.status as TicketStatus, hasActiveRun: active.has(t.id) }));
    const claude24h = in24h.filter((r) => r.status !== 'killed');
    const state = worker ? workerState(worker, now.getTime(), settings?.stageTimeoutMin ?? 20) : 'unknown';

    return {
      worker: {
        state,
        phase: worker?.phase ?? null,
        phaseDetail: worker?.phaseDetail ?? null,
        phaseSince: worker?.phaseSince?.toISOString() ?? null,
        uptimeSec: worker?.startedAt && state !== 'offline' ? Math.round((now.getTime() - worker.startedAt.getTime()) / 1000) : null,
        restarts24h: starts,
        queueDepth: tickets.filter((t) => ACTIONABLE_STATUSES.includes(t.status) && !t.hasActiveRun).length,
      },
      stuck: findStuck(tickets, now, thresholds),
      failures: { last24h: failureRates(in24h), last7d: failureRates(rows) },
      load: stageLoad(rows),
      integrations: integrationRates({ total: claude24h.length, errors: claude24h.filter((r) => r.status === 'failed' && r.errorSource === 'claude').length }, events24h),
      recentErrors: recent.map((e) => ({ id: e.id, at: e.at.toISOString(), source: e.source, message: e.message, errorCode: e.errorCode, ticketId: e.ticketId, ticketKey: e.ticket?.key ?? null })),
    };
  }
}
