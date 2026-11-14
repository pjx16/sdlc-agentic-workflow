import type { EventDraft } from '@sdlc/shared';
import type { Prisma } from '../generated/prisma/client';

/** Anything with `event.create`: the Prisma client, or a transaction client. */
export interface EventWriter {
  event: { create(args: { data: Prisma.EventUncheckedCreateInput }): Promise<unknown> };
}

export interface EventContext {
  ticketId?: string | null;
  stageRunId?: string | null;
  subtaskId?: string | null;
}

/** Writes one typed event (BUILD_PLAN v1 6.4). Use the `events.*` helpers from @sdlc/shared to build the draft. */
export async function writeEvent(db: EventWriter, draft: EventDraft, ctx: EventContext = {}): Promise<void> {
  await db.event.create({
    data: {
      ticketId: ctx.ticketId ?? null,
      stageRunId: ctx.stageRunId ?? null,
      subtaskId: ctx.subtaskId ?? null,
      type: draft.type,
      level: draft.level,
      source: draft.source,
      message: draft.message.slice(0, 500),
      errorCode: draft.errorCode ?? null,
      data: (draft.data ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** The same, but a failure to write the event is swallowed: an audit line must never stop the pipeline. */
export async function logEvent(db: EventWriter, draft: EventDraft, ctx: EventContext = {}): Promise<void> {
  await writeEvent(db, draft, ctx).catch(() => undefined);
}
