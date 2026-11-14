import { ACTIONABLE_STATUSES, type TicketStatus } from '@sdlc/shared';

/** Pure calculations behind the operations page (BUILD_PLAN v1 6.4). No database here, so they are unit-tested directly. */

export interface StuckThresholds {
  /** A ticket in a state the worker acts on, with nothing running and no change for this long, is stuck. Default 30 min. */
  actionableMin: number;
  /** A ticket waiting for a person (approval, human review, hold) for this long is stuck. Default 24 h. */
  awaitingHours: number;
}
export const DEFAULT_STUCK: StuckThresholds = { actionableMin: 30, awaitingHours: 24 };

export interface StuckInput {
  id: string;
  key: string;
  status: TicketStatus;
  updatedAt: Date;
  hasActiveRun: boolean;
}
export interface StuckTicket {
  id: string;
  key: string;
  status: TicketStatus;
  since: string;
  minutes: number;
  /** Plain English: what it is waiting for. */
  why: string;
}

const FINISHED: readonly TicketStatus[] = ['DONE', 'FAILED'];

export function findStuck(tickets: StuckInput[], now: Date, t: StuckThresholds = DEFAULT_STUCK): StuckTicket[] {
  const out: StuckTicket[] = [];
  for (const k of tickets) {
    if (FINISHED.includes(k.status) || k.hasActiveRun) continue;
    const minutes = Math.floor((now.getTime() - k.updatedAt.getTime()) / 60_000);
    const actionable = ACTIONABLE_STATUSES.includes(k.status);
    if (actionable && minutes >= t.actionableMin) out.push({ id: k.id, key: k.key, status: k.status, since: k.updatedAt.toISOString(), minutes, why: `Ready for the worker for ${minutes} minutes, but nothing is running` });
    else if (!actionable && minutes >= t.awaitingHours * 60) out.push({ id: k.id, key: k.key, status: k.status, since: k.updatedAt.toISOString(), minutes, why: `Waiting for a person for ${Math.floor(minutes / 60)} hours` });
  }
  return out.sort((a, b) => b.minutes - a.minutes);
}

export interface RunRow {
  stage: string;
  status: string;
  attempt: number;
  round: number;
  errorCode: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface StageFailure {
  stage: string;
  runs: number;
  failed: number;
  /** 0 to 1. */
  rate: number;
  byCode: Record<string, number>;
}

/** Failure rate by stage and by error code over the runs given. A run that was killed is not a failure. */
export function failureRates(runs: RunRow[]): { byStage: StageFailure[]; byCode: { code: string; count: number }[] } {
  const stages = new Map<string, StageFailure>();
  const codes = new Map<string, number>();
  for (const r of runs) {
    const s = stages.get(r.stage) ?? { stage: r.stage, runs: 0, failed: 0, rate: 0, byCode: {} };
    s.runs++;
    if (r.status === 'failed') {
      s.failed++;
      const code = r.errorCode ?? 'UNCLASSIFIED';
      s.byCode[code] = (s.byCode[code] ?? 0) + 1;
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    stages.set(r.stage, s);
  }
  const byStage = [...stages.values()].map((s) => ({ ...s, rate: s.runs === 0 ? 0 : s.failed / s.runs })).sort((a, b) => b.rate - a.rate || b.runs - a.runs);
  const byCode = [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
  return { byStage, byCode };
}

export interface StageLoad {
  stage: string;
  runs: number;
  /** Runs that were a retry (attempt above 1). */
  retries: number;
  /** Runs that were a fix round (round above 0). */
  loops: number;
  avgDurationSec: number;
  avgTokens: number;
  avgCostUsd: number;
}

/** Loop and retry counts, and average duration, tokens and cost, by stage. */
export function stageLoad(runs: RunRow[]): StageLoad[] {
  const map = new Map<string, { runs: number; retries: number; loops: number; dur: number; durN: number; tokens: number; cost: number }>();
  for (const r of runs) {
    const m = map.get(r.stage) ?? { runs: 0, retries: 0, loops: 0, dur: 0, durN: 0, tokens: 0, cost: 0 };
    m.runs++;
    if (r.attempt > 1) m.retries++;
    if (r.round > 0) m.loops++;
    if (r.startedAt && r.endedAt) {
      m.dur += (r.endedAt.getTime() - r.startedAt.getTime()) / 1000;
      m.durN++;
    }
    m.tokens += r.inputTokens + r.outputTokens;
    m.cost += r.costUsd;
    map.set(r.stage, m);
  }
  return [...map.entries()]
    .map(([stage, m]) => ({ stage, runs: m.runs, retries: m.retries, loops: m.loops, avgDurationSec: m.durN ? Math.round(m.dur / m.durN) : 0, avgTokens: Math.round(m.tokens / m.runs), avgCostUsd: Math.round((m.cost / m.runs) * 1000) / 1000 }))
    .sort((a, b) => b.runs - a.runs);
}

export interface IntegrationRate {
  source: string;
  total: number;
  errors: number;
  rate: number;
}

/** Error rate for each outside system: Claude from the stage runs, the others from their events (warnings and errors count). */
export function integrationRates(claude: { total: number; errors: number }, events: { source: string; level: string }[]): IntegrationRate[] {
  const out: IntegrationRate[] = [{ source: 'claude', total: claude.total, errors: claude.errors, rate: claude.total ? claude.errors / claude.total : 0 }];
  for (const source of ['jira', 'confluence', 'github']) {
    const mine = events.filter((e) => e.source === source);
    const errors = mine.filter((e) => e.level !== 'info').length;
    out.push({ source, total: mine.length, errors, rate: mine.length ? errors / mine.length : 0 });
  }
  return out;
}
