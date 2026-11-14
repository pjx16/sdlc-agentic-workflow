import { Injectable, Logger } from '@nestjs/common';
import { defaultPriority, events, type SupportKind, type SupportPriority } from '@sdlc/shared';
import { logEvent } from '../common/event-log';
import type { SupportTicket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RaiseInput {
  kind: SupportKind;
  title: string;
  /** Markdown. */
  body: string;
  priority?: SupportPriority;
  projectId?: string | null;
  ticketId?: string | null;
  stageRunId?: string | null;
  stage?: string;
  /** For open_question: the answer the plan used. */
  defaultAnswer?: string | null;
  /** The same problem never opens two tickets: while one with this key is open, raising again returns it. */
  dedupeKey?: string;
}

/** Told when a blocking ticket is raised, to put it where the team looks (Jira comment, PR comment). Worker only. */
export interface SupportNotifierPort {
  onRaised(ticket: SupportTicket): Promise<void>;
}

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/**
 * The one way anything raises or closes a support ticket (BUILD_PLAN v1 6.5): "anything that needs a human becomes exactly
 * one support ticket". Used by the transition listener, the stage outcomes, the credential checks and the plan handler.
 */
@Injectable()
export class SupportRaiser {
  private readonly logger = new Logger(SupportRaiser.name);
  /** Set by the worker, which can reach Jira and GitHub. The API process leaves it empty. */
  notifier: SupportNotifierPort | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Whether the ticket has an open support ticket of this kind. */
  async hasOpen(ticketId: string, kind: SupportTicket['kind']): Promise<boolean> {
    return (await this.prisma.supportTicket.count({ where: { ticketId, kind, status: 'open' } })) > 0;
  }

  async raise(input: RaiseInput): Promise<{ ticket: SupportTicket; created: boolean }> {
    if (input.dedupeKey) {
      const existing = await this.prisma.supportTicket.findFirst({ where: { dedupeKey: input.dedupeKey, status: 'open' } });
      if (existing) return { ticket: existing, created: false };
    }
    const projectId = input.projectId ?? (input.ticketId ? (await this.prisma.ticket.findUnique({ where: { id: input.ticketId }, select: { projectId: true } }))?.projectId : null) ?? null;
    // A run id that is not on record (it was cleaned up, or a test) is left out rather than failing the ticket.
    const stageRunId = input.stageRunId && (await this.prisma.stageRun.count({ where: { id: input.stageRunId } })) > 0 ? input.stageRunId : null;
    let ticket: SupportTicket;
    try {
      ticket = await this.prisma.supportTicket.create({
        data: {
          kind: input.kind,
          title: input.title.slice(0, 200),
          body: input.body,
          priority: input.priority ?? defaultPriority(input.kind),
          projectId,
          ticketId: input.ticketId ?? null,
          stageRunId,
          stage: input.stage ?? '',
          defaultAnswer: input.defaultAnswer ?? null,
          dedupeKey: input.dedupeKey ?? null,
        },
      });
    } catch (err) {
      // Two raisers at once: the partial unique index let one through. The other gets that ticket.
      if (isUniqueViolation(err) && input.dedupeKey) {
        const existing = await this.prisma.supportTicket.findFirst({ where: { dedupeKey: input.dedupeKey, status: 'open' } });
        if (existing) return { ticket: existing, created: false };
      }
      throw err;
    }
    await logEvent(this.prisma, events.note({ source: 'system', type: 'support', message: `Needs you: ${ticket.title}`, level: ticket.priority === 'blocking' ? 'warn' : 'info' }), { ticketId: ticket.ticketId, stageRunId: ticket.stageRunId });
    if (this.notifier) await this.notifier.onRaised(ticket).catch((e: unknown) => this.logger.warn(`Notifying about "${ticket.title}" failed: ${e instanceof Error ? e.message : String(e)}`));
    return { ticket, created: true };
  }

  /**
   * A credential the system relies on was refused (Claude, Jira, GitHub). One global ticket per credential, closed by itself
   * when the credential test passes (see CredentialsService.markVerified).
   */
  async credentialFailed(group: 'claude' | 'jira' | 'github' | 'confluence', detail: string): Promise<void> {
    const name = { claude: 'Claude', jira: 'Jira', github: 'GitHub', confluence: 'Confluence' }[group];
    await this.raise({ kind: 'credential', dedupeKey: `credential:${group}`, stage: '', title: `${name} rejected the credential`, body: `${detail}\n\nUpdate it in Settings → Connections. This ticket closes by itself when the credential test passes.` });
  }

  /** Closes the open tickets that match, by the system or a person. Returns how many were closed. */
  async close(where: { ticketId?: string; projectId?: string; kind?: SupportKind | SupportKind[]; dedupeKey?: string; stage?: string }, status: 'resolved' | 'dismissed', by: string, response?: string): Promise<number> {
    const kinds = where.kind === undefined ? undefined : Array.isArray(where.kind) ? { in: where.kind } : where.kind;
    const { count } = await this.prisma.supportTicket.updateMany({
      where: { status: { in: ['open', 'answered'] }, ...(where.ticketId ? { ticketId: where.ticketId } : {}), ...(where.projectId ? { projectId: where.projectId } : {}), ...(kinds ? { kind: kinds } : {}), ...(where.dedupeKey ? { dedupeKey: where.dedupeKey } : {}), ...(where.stage ? { stage: where.stage } : {}) },
      data: { status, resolvedBy: by, resolvedAt: new Date(), ...(response ? { response } : {}) },
    });
    return count;
  }
}

/** True for a failure that no retry will fix because the credential was refused (HTTP 401 or 403). */
export function isAuthFailure(err: unknown): boolean {
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return true;
  return /\bHTTP 40[13]\b|\b40[13]\b.*(unauthorized|forbidden|bad credentials)|bad credentials/i.test(err instanceof Error ? err.message : String(err));
}
