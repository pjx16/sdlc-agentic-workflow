import { Injectable, Logger } from '@nestjs/common';
import { DECISION_POINTS, ProjectSettingsSchema, automaticMoves, decisionPointOf, legalMoves, validateDecision, type Move, type StageEnvelope } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StageLauncher } from '../pipeline/stage-launcher';
import type { StepOutcome } from '../pipeline/step-handler';

const THINKING_TOKENS = 2000;
const KEPT_EVENTS = 5;

/** The state a move would run, so a move into a stage the project switched off is never offered. */
const STAGE_OF_STATE: Record<string, 'kbUpdate' | 'prReview' | undefined> = { KB_UPDATE: 'kbUpdate', REVIEW: 'prReview' };

/**
 * The orchestrator (BUILD_PLAN v1 6.11). Code asks it only where several automatic moves are legal and a decision point is defined:
 * no move means wait, one move is taken by code with no AI call, and only several moves call the agent. Its answer must be one of the
 * legal moves; anything else is replaced by the default move and recorded as a warning. Every decision is stored and written as an event.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
  ) {}

  /** Looks at a step's outcome and, at a decision point with several legal moves, lets the orchestrator replace the default move. */
  async review(ticket: Ticket, outcome: StepOutcome): Promise<StepOutcome> {
    if (outcome.kind !== 'transition') return outcome;
    const point = decisionPointOf(ticket.status);
    if (!point) return outcome;
    try {
      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
      const settings = ProjectSettingsSchema.parse(project.settings);
      if (!settings.stages.orchestrate.enabled) return outcome;
      const legal = automaticMoves(legalMoves({ status: ticket.status, gates: settings.gates, moves: [] } as never)).filter((m) => {
        const stage = STAGE_OF_STATE[m.to];
        return !stage || settings.stages[stage].enabled;
      });
      const fallback = legal.find((m) => m.to === outcome.to);
      if (legal.length < 2 || !fallback) return outcome; // none: wait; one: code takes it, with no AI call
      const chosen = await this.decide(ticket, point, legal, fallback);
      return chosen.to === outcome.to ? outcome : { ...outcome, to: chosen.to, reason: `${outcome.reason}; the orchestrator chose ${chosen.to} instead` };
    } catch (err) {
      this.logger.warn(`Orchestrator failed for ${ticket.key}: ${err instanceof Error ? err.message : String(err)}`);
      return outcome;
    }
  }

  async decide(ticket: Ticket, point: keyof typeof DECISION_POINTS, legal: Move[], fallback: Move): Promise<Move> {
    const spec = DECISION_POINTS[point];
    const result = await this.launcher.launch(
      ticket,
      'orchestrate',
      { orchestrate: await this.input(ticket, spec.question, legal, fallback) },
      { workspacePath: this.launcher.workspaceOf(ticket), ...(spec.thinking ? { thinkingTokens: THINKING_TOKENS } : {}) },
    );
    let move = fallback;
    let reason = '';
    let fallbackUsed = true;
    let why = 'the orchestrator did not answer';
    let stageRunId: string | undefined;
    if (result.kind === 'done') {
      stageRunId = result.stageRunId;
      const data = (result.envelope as StageEnvelope).data as { move?: { kind: string; to: string }; reason?: string } | undefined;
      const verdict = validateDecision(data?.move, legal);
      if (verdict.ok) {
        move = verdict.move;
        reason = data?.reason ?? '';
        fallbackUsed = false;
      } else why = verdict.reason;
    } else if ('stageRunId' in result) stageRunId = result.stageRunId;

    const run = stageRunId ? await this.prisma.stageRun.findUnique({ where: { id: stageRunId } }) : null;
    await this.prisma.orchestratorDecision.create({
      data: {
        ticketId: ticket.id,
        point,
        legalMoves: legal as never,
        chosen: `${move.kind} ${move.to}`,
        reason: fallbackUsed ? why : reason,
        fallbackUsed,
        stageRunId: stageRunId ?? null,
        model: run?.model ?? null,
        inputTokens: run?.inputTokens ?? 0,
        outputTokens: run?.outputTokens ?? 0,
        costUsd: run?.costUsd ?? 0,
      },
    });
    await this.prisma.event.create({
      data: {
        ticketId: ticket.id,
        type: 'orchestrator',
        level: fallbackUsed ? 'warn' : 'info',
        source: 'orchestrator',
        stageRunId: stageRunId ?? null,
        message: (fallbackUsed ? `The orchestrator's answer was not used (${why}); the default move to ${move.to} was taken` : `The orchestrator chose ${move.kind} ${move.to}: ${reason}`).slice(0, 500),
      },
    });
    return move;
  }

  /** A short summary: never code or diffs (BUILD_PLAN v1 6.11). */
  private async input(ticket: Ticket, question: string, legal: Move[], fallback: Move) {
    const [events, run, findings, support] = await Promise.all([
      this.prisma.event.findMany({ where: { ticketId: ticket.id }, orderBy: { at: 'desc' }, take: KEPT_EVENTS }),
      this.prisma.stageRun.findFirst({ where: { ticketId: ticket.id, status: 'succeeded' }, orderBy: { endedAt: 'desc' } }),
      this.prisma.reviewFinding.findMany({ where: { ticketId: ticket.id, status: 'open' } }),
      this.prisma.supportTicket.findMany({ where: { ticketId: ticket.id, status: 'open' } }),
    ]);
    const summary = ((run?.resultJson ?? {}) as { summary?: string }).summary ?? '';
    return {
      ticketKey: ticket.key,
      kind: ticket.kind,
      state: ticket.status,
      question,
      moves: legal.map((m) => ({ kind: m.kind, to: m.to, label: m.label, isDefault: m.to === fallback.to })),
      events: events.reverse().map((e) => e.message.slice(0, 200)),
      lastSummary: summary.slice(0, 400),
      counts: `review rounds ${ticket.reviewRound}, CI fix ${ticket.ciFixDone ? 'used' : 'not used'}, CI re-run ${ticket.ciRerunDone ? 'used' : 'not used'}`,
      findings: findings.map((f) => `${f.severity} (${f.reviewer})`),
      supportTickets: support.map((s) => `${s.kind}: ${s.title}`.slice(0, 120)),
    };
  }
}
