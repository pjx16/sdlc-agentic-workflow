import type { PrismaService } from '../../prisma/prisma.service';

const ID = 'worker';

/** The worker's heartbeat: written every iteration, so the dashboard can tell "online and idle" from "not running". */
export async function recordTick(prisma: Pick<PrismaService, 'workerStatus'>, outcome: string, detail?: string): Promise<void> {
  const data = { heartbeatAt: new Date(), tickOutcome: outcome, tickDetail: detail ?? null };
  await prisma.workerStatus.upsert({ where: { id: ID }, update: data, create: { id: ID, ...data } }).catch(() => undefined);
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
