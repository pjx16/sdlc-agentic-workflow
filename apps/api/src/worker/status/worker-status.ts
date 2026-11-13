import type { PrismaService } from '../../prisma/prisma.service';

const ID = 'worker';

/** How often the heartbeat timer writes (BUILD_PLAN v1 6.1). The dashboard calls the worker offline after 30 s. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** The worker's heartbeat: a bare timestamp, written by a timer that does not depend on the loop. */
export async function recordHeartbeat(prisma: Pick<PrismaService, 'workerStatus'>, now: Date = new Date()): Promise<void> {
  await prisma.workerStatus
    .upsert({ where: { id: ID }, update: { heartbeatAt: now }, create: { id: ID, heartbeatAt: now, tickOutcome: 'starting' } })
    .catch(() => undefined);
}

/** The outcome of one loop iteration. It no longer doubles as the heartbeat: an iteration can run for minutes. */
export async function recordTick(prisma: Pick<PrismaService, 'workerStatus'>, outcome: string, detail?: string): Promise<void> {
  const data = { tickOutcome: outcome, tickDetail: detail ?? null };
  await prisma.workerStatus.upsert({ where: { id: ID }, update: data, create: { id: ID, heartbeatAt: new Date(), ...data } }).catch(() => undefined);
}

/** Writes the heartbeat on its own timer, whether or not a loop iteration is running. */
export class HeartbeatTimer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: Pick<PrismaService, 'workerStatus'>,
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {}

  /** Writes one beat now, then one every interval. Calling it twice does nothing. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => void recordHeartbeat(this.prisma), this.intervalMs);
    this.timer.unref();
    await recordHeartbeat(this.prisma);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface IntakeRecord {
  mode: 'rest' | 'mcp';
  /** Enabled projects in this Jira mode whose mirror is ready: the ones that were polled. */
  projects: number;
  /** Enabled projects in this Jira mode that were left out because the mirror is not ready. */
  waiting: number;
  created: number;
  seen: number;
  error?: string;
  skipped?: string;
}

/** The result of the last Jira intake poll, one row per mode (`intake-rest`, `intake-mcp`). Also leaves an Event when tickets arrived or a new error appeared. */
export async function recordIntake(prisma: Pick<PrismaService, 'workerStatus' | 'event'>, r: IntakeRecord): Promise<void> {
  try {
    const id = `intake-${r.mode}`;
    const previous = await prisma.workerStatus.findUnique({ where: { id } });
    const data = {
      intakeMode: r.mode,
      intakeAt: new Date(),
      intakeProjects: r.projects,
      intakeWaiting: r.waiting,
      intakeCreated: r.created,
      intakeSeen: r.seen,
      intakeError: r.error ?? null,
      intakeSkipped: r.skipped ?? null,
    };
    await prisma.workerStatus.upsert({ where: { id }, update: data, create: { id, heartbeatAt: new Date(), tickOutcome: 'intake', ...data } });
    const label = r.mode === 'rest' ? 'Jira (REST)' : 'Jira (MCP)';
    if (r.created > 0) await prisma.event.create({ data: { type: 'jira', message: `${label} intake: ${r.created} new ticket${r.created === 1 ? '' : 's'}` } });
    if (r.error && r.error !== previous?.intakeError) await prisma.event.create({ data: { type: 'jira', message: `${label} intake failed: ${r.error}`.slice(0, 500) } });
  } catch {
    /* status is best effort: it must never stop the loop */
  }
}
