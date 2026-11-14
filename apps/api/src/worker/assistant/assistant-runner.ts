import { existsSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_GLOBAL_SETTINGS, GlobalSettingsSchema, ProjectSettingsSchema, describeError, type ErrorCode, type ModelAlias } from '@sdlc/shared';
import type { AssistantConversation, AssistantMessage, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentRunner, type StageResult } from '../agent-runner/agent-runner';
import { lookup } from '../kb/kb-index';
import { WorkerConfig } from '../worker-config';
import { buildContextPack, defaultLogTail, type PackDeps } from './context-pack';

/** After this many messages, older turns are replaced by a short summary (BUILD_PLAN v1 6.6). */
export const MESSAGES_BEFORE_SUMMARY = 10;
/** What stays word for word once a summary is used. */
export const RECENT_MESSAGES = 4;
const SUMMARY_CHARS_PER_MESSAGE = 160;
const POLL_MS = 2000;

/** A short, deterministic summary of older turns: who said what, each cut to its first words. */
export function summarize(older: Pick<AssistantMessage, 'role' | 'text'>[]): string {
  return older
    .map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS_PER_MESSAGE)}`)
    .join('\n')
    .slice(0, 2000);
}

export interface Window {
  summary: string | null;
  history: { role: 'user' | 'assistant'; text: string }[];
  /** The CLI session can be continued only while nothing has been summarised away. */
  canResume: boolean;
}

/** What goes into the prompt: everything while the conversation is short, else a summary of the older turns plus the latest few. */
export function windowOf(before: Pick<AssistantMessage, 'role' | 'text'>[]): Window {
  const history = (ms: Pick<AssistantMessage, 'role' | 'text'>[]) => ms.map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
  if (before.length + 1 <= MESSAGES_BEFORE_SUMMARY) return { summary: null, history: history(before), canResume: true };
  const recent = before.slice(-RECENT_MESSAGES);
  return { summary: summarize(before.slice(0, before.length - recent.length)), history: history(recent), canResume: false };
}

/**
 * Answers the messages people send in the assistant chat (BUILD_PLAN v1 6.6, D7). It runs on its own timer, outside the worker
 * loop's one-stage-at-a-time rule, because it is interactive and should not wait behind a long stage. At most one session runs at
 * a time, it counts toward the usage gate like any stage, and it is refused while the pipeline is paused for limits.
 */
@Injectable()
export class AssistantRunner {
  private readonly logger = new Logger(AssistantRunner.name);
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** Replaced in tests. */
  deps: PackDeps;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    private readonly runner: AgentRunner,
  ) {
    this.deps = {
      logTail: defaultLogTail,
      featureDoc: async (t) => {
        const project = await this.prisma.project.findUnique({ where: { id: t.projectId } });
        const key = (t.featureKey ?? '').trim();
        if (!project || !key) return null;
        const ws = this.config.workspacePath(t.projectId, t.key);
        if (!existsSync(ws)) return null;
        return (await lookup(ws, project.kbDir, key)).match?.content ?? null;
      },
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Answers the oldest waiting message. Never throws. */
  async tick(): Promise<'busy' | 'paused' | 'idle' | 'answered'> {
    if (this.running) return 'busy';
    this.running = true;
    try {
      const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
      if (settings?.pipelinePaused && settings.pausedReason !== 'manual') return 'paused';
      const conversation = await this.prisma.assistantConversation.findFirst({ where: { pendingAt: { not: null } }, orderBy: { pendingAt: 'asc' } });
      if (!conversation) return 'idle';
      await this.answer(conversation).catch(async (err: unknown) => {
        this.logger.error(`Assistant failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        await this.reply(conversation.id, `Something went wrong while answering: ${err instanceof Error ? err.message : String(err)}`);
      });
      return 'answered';
    } finally {
      this.running = false;
    }
  }

  private async reply(conversationId: string, text: string, extra: { draft?: unknown; stageRunId?: string; tokens?: number; sessionId?: string | null } = {}): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.assistantMessage.create({ data: { conversationId, role: 'assistant', text, draft: (extra.draft ?? undefined) as Prisma.InputJsonValue | undefined, stageRunId: extra.stageRunId ?? null } }),
      this.prisma.assistantConversation.update({
        where: { id: conversationId },
        data: { pendingAt: null, messageCount: { increment: 1 }, ...(extra.tokens ? { tokens: { increment: extra.tokens } } : {}), ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}) },
      }),
    ]);
  }

  private async answer(conversation: AssistantConversation): Promise<void> {
    const messages = await this.prisma.assistantMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { at: 'asc' } });
    const last = [...messages].reverse().find((m) => m.role === 'user');
    if (!last) return void (await this.prisma.assistantConversation.update({ where: { id: conversation.id }, data: { pendingAt: null } }));
    const st = await this.prisma.supportTicket.findUniqueOrThrow({ where: { id: conversation.supportTicketId } });
    const project = st.projectId ? await this.prisma.project.findUnique({ where: { id: st.projectId } }) : null;
    if (!project) return this.reply(conversation.id, 'This item is not about a project, so there is no repository for me to look at. I can only answer from what is written on the ticket.');
    const settings = ProjectSettingsSchema.parse(project.settings);
    if (!settings.stages.assist.enabled) return this.reply(conversation.id, 'The assistant is turned off for this project.');
    const mirror = this.config.mirrorPath(project.id);
    if (!existsSync(mirror)) return this.reply(conversation.id, "The project's repository mirror is not ready yet, so I cannot look at the code. Try again in a minute.");

    const win = windowOf(messages.filter((m) => m.id !== last.id));
    const pack = await buildContextPack(this.prisma, st, this.deps);
    if (win.summary !== null && win.summary !== conversation.summary) await this.prisma.assistantConversation.update({ where: { id: conversation.id }, data: { summary: win.summary } });

    const global = await this.global();
    const result = await this.runner.run({
      projectId: project.id,
      ticketId: st.ticketId ?? undefined,
      stage: 'assist',
      stack: project.stack,
      claudeMdMode: project.claudeMdMode,
      modelAlias: settings.stages.assist.model as ModelAlias,
      modelAliases: global.modelAliases,
      maxTurns: settings.stages.assist.maxTurns,
      stageTimeoutMin: global.stageTimeoutMin,
      inputs: { assist: { pack: pack.text, summary: win.summary, history: win.history, message: last.text } },
      workspacePath: mirror,
      resumeSession: win.canResume && conversation.sessionId ? conversation.sessionId : undefined,
    });
    await this.finish(conversation, win.canResume, result);
  }

  private async finish(conversation: AssistantConversation, canResume: boolean, result: StageResult): Promise<void> {
    const run = 'stageRunId' in result && result.stageRunId ? await this.prisma.stageRun.findUnique({ where: { id: result.stageRunId } }) : null;
    const tokens = run ? run.inputTokens + run.outputTokens : 0;
    const keep = { stageRunId: run?.id, tokens, sessionId: canResume ? (run?.sessionId ?? conversation.sessionId) : null };
    switch (result.kind) {
      case 'done': {
        const data = (result.envelope.data ?? {}) as { reply?: string; draft?: { kind: string; text: string } | null };
        return this.reply(conversation.id, data.reply ?? result.envelope.summary, { ...keep, draft: data.draft ?? undefined });
      }
      case 'needs_input':
        return this.reply(conversation.id, result.question, keep);
      case 'rate_limited':
        return this.reply(conversation.id, describeError(result.errorCode ?? 'CLAUDE_USAGE_LIMIT', { time: result.resetsAt?.toLocaleTimeString() }), keep);
      case 'claude_auth':
        return this.reply(conversation.id, describeError('CLAUDE_AUTH'), keep);
      case 'turn_limit':
        return this.reply(conversation.id, 'I ran out of turns before I could answer. Ask a narrower question, or raise the assistant turn limit in the project settings.', keep);
      case 'killed':
        return this.reply(conversation.id, 'That answer was stopped.', keep);
      case 'failed':
        return this.reply(conversation.id, result.errorCode ? describeError(result.errorCode as ErrorCode, { detail: result.reason, agent: 'The assistant', stage: 'assist' }) : `I could not answer: ${result.reason}`, keep);
    }
  }

  private async global() {
    const row = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (!row) return DEFAULT_GLOBAL_SETTINGS;
    return GlobalSettingsSchema.parse({ stageTimeoutMin: row.stageTimeoutMin, modelAliases: row.modelAliases });
  }
}
