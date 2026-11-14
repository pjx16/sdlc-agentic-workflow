import { HttpStatus, Injectable } from '@nestjs/common';
import { ASSIST_DRAFT_KINDS, ErrorCodes, planDiff, type SupportKind } from '@sdlc/shared';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import type { AssistantMessage, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupportService, type SupportTicketDto } from './support.service';

const MessageBody = z.object({ text: z.string().trim().min(1, 'is required').max(4000, 'must be at most 4000 characters') });
const DraftSchema = z.object({ kind: z.enum(ASSIST_DRAFT_KINDS), text: z.string().min(1), appliedAt: z.string().optional() });

export interface AssistantMessageDto {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  draft: { kind: (typeof ASSIST_DRAFT_KINDS)[number]; text: string; appliedAt: string | null; /** For an edited plan: what it changes against the plan on the ticket. */ diff: string | null } | null;
  at: string;
}

export interface AssistantDto {
  /** Whether the chat can take a new message right now, and if not, why. */
  canSend: boolean;
  blockedReason: string | null;
  /** The assistant is working on the last message. */
  pending: boolean;
  tokens: number;
  tokenCap: number;
  /** The conversation used its token budget (BUILD_PLAN v1 6.6). */
  capReached: boolean;
  messages: AssistantMessageDto[];
}

/** Which drafts make sense on which kind of ticket, and the support action each one is applied through. */
const DRAFT_ACTIONS: Record<(typeof ASSIST_DRAFT_KINDS)[number], { kinds: SupportKind[]; stage?: string }> = {
  answer: { kinds: ['question', 'open_question'] },
  plan_edit: { kinds: ['approval'], stage: 'plan' },
  rerun_note: { kinds: ['approval'] },
};

const toDto = (m: AssistantMessage, currentPlan: string | null): AssistantMessageDto => {
  const draft = m.draft ? DraftSchema.safeParse(m.draft) : null;
  return {
    id: m.id,
    role: m.role as 'user' | 'assistant',
    text: m.text,
    draft: draft?.success ? { kind: draft.data.kind, text: draft.data.text, appliedAt: draft.data.appliedAt ?? null, diff: draft.data.kind === 'plan_edit' && currentPlan ? planDiff(currentPlan, draft.data.text) : null } : null,
    at: m.at.toISOString(),
  };
};

@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly support: SupportService,
  ) {}

  private async ticket(id: string) {
    const st = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!st) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Support ticket not found');
    return st;
  }

  /** Why a message cannot be sent now, or null. */
  private async blocked(conversation: { tokens: number; pendingAt: Date | null } | null): Promise<{ reason: string | null; cap: number }> {
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const cap = settings?.assistantTokenCap ?? 200_000;
    if (settings?.pipelinePaused && settings.pausedReason !== 'manual') return { reason: `The pipeline is paused (${settings.pausedReason ?? 'usage limit'}), so the assistant is paused too. It comes back when the pipeline resumes.`, cap };
    if (conversation && conversation.tokens >= cap) return { reason: `This conversation used its ${cap.toLocaleString('en-US')} token budget. Raise the assistant token cap in Settings to go on.`, cap };
    if (conversation?.pendingAt) return { reason: 'The assistant is still answering your last message.', cap };
    return { reason: null, cap };
  }

  /** GET /support-tickets/:id/assistant */
  async get(supportTicketId: string): Promise<AssistantDto> {
    const st = await this.ticket(supportTicketId);
    const currentPlan = st.ticketId ? ((await this.prisma.ticket.findUnique({ where: { id: st.ticketId }, select: { planMarkdown: true } }))?.planMarkdown ?? null) : null;
    const conversation = await this.prisma.assistantConversation.findUnique({ where: { supportTicketId }, include: { messages: { orderBy: { at: 'asc' } } } });
    const { reason, cap } = await this.blocked(conversation);
    return {
      canSend: reason === null,
      blockedReason: reason,
      pending: Boolean(conversation?.pendingAt),
      tokens: conversation?.tokens ?? 0,
      tokenCap: cap,
      capReached: (conversation?.tokens ?? 0) >= cap,
      messages: (conversation?.messages ?? []).map((m) => toDto(m, currentPlan)),
    };
  }

  /** POST /support-tickets/:id/assistant/messages: stores the message; the worker answers it. */
  async send(supportTicketId: string, body: unknown): Promise<AssistantDto> {
    const { text } = parseBody(MessageBody, body);
    const st = await this.ticket(supportTicketId);
    if (st.status !== 'open' && st.status !== 'answered') throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `This ticket is already ${st.status}`);
    const existing = await this.prisma.assistantConversation.findUnique({ where: { supportTicketId } });
    const { reason } = await this.blocked(existing);
    if (reason) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, reason);
    const conversation = existing ?? (await this.prisma.assistantConversation.create({ data: { supportTicketId } }));
    await this.prisma.$transaction([
      this.prisma.assistantMessage.create({ data: { conversationId: conversation.id, role: 'user', text } }),
      // Only the first writer wins when two messages race: the conversation is marked waiting once.
      this.prisma.assistantConversation.update({ where: { id: conversation.id }, data: { pendingAt: new Date(), messageCount: { increment: 1 } } }),
    ]);
    return this.get(supportTicketId);
  }

  /** POST /support-tickets/:id/assistant/messages/:messageId/apply: the person applies a draft; it goes through the normal action. */
  async apply(supportTicketId: string, messageId: string): Promise<SupportTicketDto> {
    const st = await this.ticket(supportTicketId);
    const message = await this.prisma.assistantMessage.findFirst({ where: { id: messageId, conversation: { supportTicketId } } });
    const draft = message?.draft ? DraftSchema.safeParse(message.draft) : null;
    if (!message || !draft?.success) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'There is no draft on that message');
    if (draft.data.appliedAt) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'This draft was already applied');
    const rule = DRAFT_ACTIONS[draft.data.kind];
    if (!rule.kinds.includes(st.kind as SupportKind) || (rule.stage && st.stage !== rule.stage)) {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `A ${draft.data.kind.replace('_', ' ')} draft cannot be applied to a ${st.kind.replace('_', ' ')} ticket`);
    }
    // The assistant never changes anything: applying is the person's click, and it goes through the same action as the buttons.
    const result =
      draft.data.kind === 'answer'
        ? await this.support.act(st.id, { action: 'answer', answer: draft.data.text })
        : draft.data.kind === 'plan_edit'
          ? await this.support.act(st.id, { action: 'approve', planMarkdown: draft.data.text })
          : await this.support.act(st.id, { action: 'reject', note: draft.data.text.slice(0, 2000) });
    await this.prisma.assistantMessage.update({ where: { id: message.id }, data: { draft: { ...draft.data, appliedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
    return result;
  }
}
