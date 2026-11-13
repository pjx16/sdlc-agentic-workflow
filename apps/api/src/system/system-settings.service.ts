import { HttpStatus, Injectable } from '@nestjs/common';
import { DEFAULT_GLOBAL_SETTINGS, ErrorCodes, GlobalSettingsSchema, deepMerge, type GlobalSettingsInput } from '@sdlc/shared';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import type { GlobalSettings, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const GLOBAL_ID = 'global';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export interface GlobalSettingsView extends GlobalSettingsInput {
  pipelinePaused: boolean;
  pausedReason: string | null;
  resetsAt: string | null;
  usageIgnoredUntil: string | null;
  intakePaused: boolean;
}

/** What the worker last reported (see worker/status). `online` is derived from the heartbeat. */
export interface WorkerStatusView {
  /** Heartbeat is fresh. Kept for older callers; `state` is the full picture. */
  online: boolean;
  /** idle: online, nothing running. busy: online and working. stalled: online but one phase has lasted too long. offline: no heartbeat. */
  state: WorkerState;
  phase: string;
  phaseDetail: string | null;
  phaseSince: string | null;
  startedAt: string | null;
  pid: number | null;
  version: string | null;
  /** The worker started three or more times in the last 10 minutes. */
  restartingRepeatedly: boolean;
  heartbeatAt: string;
  /** idle | stepped | paused | blocked | not_configured */
  tickOutcome: string;
  tickDetail: string | null;
  /** The last Jira intake poll of each mode that has run. */
  intake: IntakeStatusView[];
}

export interface IntakeStatusView {
  mode: 'rest';
  at: string | null;
  /** Projects polled (Jira mode on, mirror ready). */
  projects: number;
  /** Projects in this mode left out because their mirror is not ready. */
  waiting: number;
  created: number;
  seen: number;
  error: string | null;
  skipped: string | null;
}

export interface RecentEvent {
  id: string;
  at: string;
  type: string;
  message: string;
  ticketId: string | null;
  ticketKey: string | null;
}

export type WorkerState = 'idle' | 'busy' | 'stalled' | 'offline';

/** A busy phase is stalled when it has lasted longer than the stage time limit plus this much (BUILD_PLAN v1 6.1). */
export const STALL_GRACE_MS = 5 * 60_000;

/** The four dashboard states, from the heartbeat and the phase. Pure, so it is tested without a database. */
export function workerState(w: { heartbeatAt: Date; phase: string; phaseSince: Date | null }, nowMs: number, stageTimeoutMin: number): WorkerState {
  if (nowMs - w.heartbeatAt.getTime() >= WORKER_ONLINE_MS) return 'offline';
  if (w.phase === 'idle' || w.phase === 'paused' || w.phase === 'not_configured') return 'idle';
  if (w.phaseSince && nowMs - w.phaseSince.getTime() > stageTimeoutMin * 60_000 + STALL_GRACE_MS) return 'stalled';
  return 'busy';
}

/** The worker is considered offline when its last heartbeat is older than this (it ticks every 5 seconds). */
export const WORKER_ONLINE_MS = 30_000;

export interface SystemView {
  settings: GlobalSettingsView;
  worker: WorkerStatusView | null;
  recentEvents: RecentEvent[];
  runningStage: { id: string; stage: string; model: string; projectId: string; ticketId: string | null; startedAt: string | null } | null;
  usage: { at: string; fiveHourPct: number | null; sevenDayPct: number | null; status: string | null; resetsAt: string | null; source: string } | null;
}

const IgnoreBody = z.object({ until: z.coerce.date({ error: 'must be a date' }).optional() });

function toView(row: GlobalSettings): GlobalSettingsView {
  const parsed = GlobalSettingsSchema.parse({
    usageThresholdPct: row.usageThresholdPct,
    usageThresholdWeeklyPct: row.usageThresholdWeeklyPct,
    calibratedWindowTokens: row.calibratedWindowTokens === null ? null : Number(row.calibratedWindowTokens),
    pollIntervalSec: row.pollIntervalSec,
    stageTimeoutMin: row.stageTimeoutMin,
    verifyTimeoutSec: row.verifyTimeoutSec,
    workspaceRetentionDays: row.workspaceRetentionDays,
    logRetentionDays: row.logRetentionDays,
    modelAliases: row.modelAliases,
    jiraMcp: row.jiraMcp,
  });
  return {
    ...parsed,
    pipelinePaused: row.pipelinePaused,
    pausedReason: row.pausedReason,
    resetsAt: row.resetsAt?.toISOString() ?? null,
    usageIgnoredUntil: row.usageIgnoredUntil?.toISOString() ?? null,
    intakePaused: row.intakePaused,
  };
}

@Injectable()
export class SystemSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The single settings row, created with the defaults on first use. */
  private async row(): Promise<GlobalSettings> {
    const d = DEFAULT_GLOBAL_SETTINGS;
    return this.prisma.globalSettings.upsert({
      where: { id: GLOBAL_ID },
      update: {},
      create: {
        id: GLOBAL_ID,
        ...d,
        modelAliases: d.modelAliases as unknown as Prisma.InputJsonValue,
        jiraMcp: d.jiraMcp as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async settings(): Promise<GlobalSettingsView> {
    return toView(await this.row());
  }

  async system(): Promise<SystemView> {
    const settings = await this.settings();
    const running = await this.prisma.stageRun.findFirst({ where: { status: 'running' }, orderBy: { startedAt: 'desc' } });
    const usage = await this.prisma.usageSnapshot.findFirst({ orderBy: { at: 'desc' } });
    const worker = await this.prisma.workerStatus.findUnique({ where: { id: 'worker' } });
    const intakeRows = await this.prisma.workerStatus.findMany({ where: { id: { in: ['intake-rest'] } }, orderBy: { id: 'asc' } });
    const restarts = await this.prisma.event.count({ where: { type: 'worker', message: { startsWith: 'Worker started' }, at: { gte: new Date(Date.now() - 10 * 60_000) } } });
    const events = await this.prisma.event.findMany({ orderBy: { at: 'desc' }, take: 8, include: { ticket: { select: { key: true } } } });
    return {
      settings,
      worker: worker && {
        online: Date.now() - worker.heartbeatAt.getTime() < WORKER_ONLINE_MS,
        state: workerState(worker, Date.now(), settings.stageTimeoutMin),
        phase: worker.phase,
        phaseDetail: worker.phaseDetail,
        phaseSince: worker.phaseSince?.toISOString() ?? null,
        startedAt: worker.startedAt?.toISOString() ?? null,
        pid: worker.pid,
        version: worker.version,
        restartingRepeatedly: restarts >= 3,
        heartbeatAt: worker.heartbeatAt.toISOString(),
        tickOutcome: worker.tickOutcome,
        tickDetail: worker.tickDetail,
        intake: intakeRows.map((r) => ({
          mode: 'rest' as const,
          at: r.intakeAt?.toISOString() ?? null,
          projects: r.intakeProjects,
          waiting: r.intakeWaiting,
          created: r.intakeCreated,
          seen: r.intakeSeen,
          error: r.intakeError,
          skipped: r.intakeSkipped,
        })),
      },
      recentEvents: events.map((e) => ({ id: e.id, at: e.at.toISOString(), type: e.type, message: e.message, ticketId: e.ticketId, ticketKey: e.ticket?.key ?? null })),
      runningStage: running && {
        id: running.id,
        stage: running.stage,
        model: running.model,
        projectId: running.projectId,
        ticketId: running.ticketId,
        startedAt: running.startedAt?.toISOString() ?? null,
      },
      usage: usage && {
        at: usage.at.toISOString(),
        fiveHourPct: usage.fiveHourPct,
        sevenDayPct: usage.sevenDayPct,
        status: usage.status,
        resetsAt: usage.resetsAt?.toISOString() ?? null,
        source: usage.source,
      },
    };
  }

  /** PATCH: merge into the current editable values, validate the whole result, then save. */
  async update(body: unknown): Promise<GlobalSettingsView> {
    const current = await this.settings();
    const editable = GlobalSettingsSchema.parse(current);
    const next = parseBody(GlobalSettingsSchema, deepMerge(editable, body ?? {}));
    const row = await this.prisma.globalSettings.update({
      where: { id: GLOBAL_ID },
      data: {
        ...next,
        modelAliases: next.modelAliases as unknown as Prisma.InputJsonValue,
        jiraMcp: next.jiraMcp as unknown as Prisma.InputJsonValue,
      },
    });
    await this.event('settings', 'Global settings updated');
    return toView(row);
  }

  async pause(): Promise<GlobalSettingsView> {
    await this.row();
    const row = await this.prisma.globalSettings.update({ where: { id: GLOBAL_ID }, data: { pipelinePaused: true, pausedReason: 'manual' } });
    await this.event('state', 'Pipeline paused (manual)');
    return toView(row);
  }

  async resume(): Promise<GlobalSettingsView> {
    await this.row();
    const row = await this.prisma.globalSettings.update({
      where: { id: GLOBAL_ID },
      data: { pipelinePaused: false, pausedReason: null, resetsAt: null },
    });
    await this.event('state', 'Pipeline resumed');
    return toView(row);
  }

  /** Ignore the usage gate until `until` (default: the current window's reset) and clear the pause. */
  async ignoreUsage(body: unknown): Promise<GlobalSettingsView> {
    const { until } = parseBody(IgnoreBody, body ?? {});
    const current = await this.row();
    if (!current.pipelinePaused) {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The pipeline is not paused');
    }
    const snapshot = await this.prisma.usageSnapshot.findFirst({ where: { resetsAt: { not: null } }, orderBy: { at: 'desc' } });
    const ignoredUntil = until ?? current.resetsAt ?? snapshot?.resetsAt ?? new Date(Date.now() + FIVE_HOURS_MS);
    const row = await this.prisma.globalSettings.update({
      where: { id: GLOBAL_ID },
      data: { usageIgnoredUntil: ignoredUntil, pipelinePaused: false, pausedReason: null, resetsAt: null },
    });
    await this.event('usage', `Usage gate ignored until ${ignoredUntil.toISOString()}`);
    return toView(row);
  }

  async setIntakePaused(paused: boolean): Promise<GlobalSettingsView> {
    await this.row();
    const row = await this.prisma.globalSettings.update({ where: { id: GLOBAL_ID }, data: { intakePaused: paused } });
    await this.event('state', paused ? 'Intake paused' : 'Intake resumed');
    return toView(row);
  }

  private event(type: string, message: string) {
    return this.prisma.event.create({ data: { type, message } });
  }
}
