import { describeError, type ErrorCode } from './error-policy';

/**
 * One plain-English sentence per kind of happening (BUILD_PLAN v1 6.4). Code never writes free-form event strings:
 * it calls one of these, so the timeline reads the same everywhere.
 */

export const EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const EVENT_SOURCES = ['system', 'orchestrator', 'claude', 'agent', 'jira', 'confluence', 'github', 'git', 'ci', 'user'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
const money = (usd: number): string => `$${usd.toFixed(2)}`;
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const cap = (s: string): string => (s ? (s[0] ?? '').toUpperCase() + s.slice(1) : s);

/** The display name of the agent behind a stage key. */
export const AGENT_LABEL: Record<string, string> = {
  kbBuild: 'Documentor', kbUpdate: 'Documentor', plan: 'Planner', breakdown: 'Breakdown', tests: 'Test writer', implement: 'Coder', fix: 'Fixer', review: 'Reviewer',
  orchestrate: 'Orchestrator', assist: 'Assistant', repoProfile: 'Repo profiler', onboardAdvise: 'Onboarding advisor', featureMap: 'Feature mapper',
  solutionDesign: 'Solution architect', bugInvestigation: 'Bug investigator', technicalDesign: 'Technical architect', prReview: 'PR reviewer',
  qualityReview: 'Quality reviewer', securityReview: 'Security reviewer', ciTriage: 'CI triager',
};
export const agentLabel = (stage: string): string => AGENT_LABEL[stage] ?? cap(stage);

export interface EventDraft {
  level: EventLevel;
  source: EventSource;
  /** The old coarse type, kept for existing filters: intake | state | stage | usage | jira | git | settings | support | error | worker. */
  type: string;
  message: string;
  errorCode?: ErrorCode;
  data?: Record<string, unknown>;
}

const subtaskLabel = (n?: number | null, of?: number | null): string => (n ? ` subtask ${n}${of ? `/${of}` : ''}` : '');

const sourceOfCode = (code: ErrorCode): EventSource =>
  code.startsWith('CLAUDE') ? 'claude' : code === 'JIRA_ERROR' ? 'jira' : code === 'CONFLUENCE_ERROR' ? 'confluence' : code === 'GITHUB_ERROR' ? 'github' : code === 'GIT_ERROR' ? 'git' : code === 'KILLED' ? 'user' : 'agent';

function errorDraft(p: { code: ErrorCode; vars?: Record<string, string | number | undefined>; retryAt?: Date; retry?: { n: number; of: number }; source?: EventSource }): EventDraft {
  const message = describeError(p.code, { ...p.vars, n: p.retry?.n, time: p.retryAt ? clock(p.retryAt) : p.vars?.time });
  return { level: 'error', source: p.source ?? sourceOfCode(p.code), type: 'error', message, errorCode: p.code };
}

export const events = {
  stageStarted: (p: { stage: string; ticketKey?: string; subtask?: number; subtasks?: number; model?: string; attempt?: number }): EventDraft => ({
    level: 'info', source: 'agent', type: 'stage',
    message: `${agentLabel(p.stage)} started${subtaskLabel(p.subtask, p.subtasks)}${p.ticketKey ? ` on ${p.ticketKey}` : ''}${p.attempt && p.attempt > 1 ? ` (attempt ${p.attempt})` : ''}`,
    data: { stage: p.stage, model: p.model },
  }),

  stageFinished: (p: { stage: string; status: 'succeeded' | 'failed' | 'needs_input' | 'killed'; subtask?: number; subtasks?: number; durationMs: number; turns: number; costUsd: number; detail?: string }): EventDraft => {
    const verb = p.status === 'succeeded' ? 'finished' : p.status === 'needs_input' ? 'asked a question' : p.status === 'killed' ? 'was stopped' : 'failed';
    const facts = [duration(p.durationMs), `${p.turns} turns`, money(p.costUsd), ...(p.detail ? [p.detail] : [])].join(' · ');
    return { level: p.status === 'failed' ? 'warn' : 'info', source: 'agent', type: 'stage', message: `${agentLabel(p.stage)} ${verb}${subtaskLabel(p.subtask, p.subtasks)} · ${facts}`, data: { stage: p.stage, status: p.status } };
  },

  transition: (p: { ticketKey: string; from: string; to: string; reason?: string | null; actor?: string; kind?: string }): EventDraft => ({
    level: 'info', source: p.actor === 'user' ? 'user' : 'system', type: 'state',
    message: `${p.ticketKey}: ${p.from} -> ${p.to}${p.reason ? ` (${p.reason})` : ''}`,
    data: { from: p.from, to: p.to, kind: p.kind ?? 'advance' },
  }),

  decision: (p: { chosen: string; over?: string[]; reason: string }): EventDraft => ({
    level: 'info', source: 'orchestrator', type: 'stage',
    message: `Orchestrator chose ${p.chosen}${p.over && p.over.length > 0 ? ` over ${p.over.join(', ')}` : ''}: ${p.reason}`,
    data: { chosen: p.chosen, over: p.over },
  }),

  error: errorDraft,
  warning: (p: { code: ErrorCode; detail: string; source?: EventSource }): EventDraft => ({ ...errorDraft({ code: p.code, vars: { detail: p.detail }, source: p.source }), level: 'warn' }),

  rerun: (p: { stage: string; note?: string; actor: string }): EventDraft => ({
    level: 'info', source: 'user', type: 'state', message: `Rerun of ${p.stage} requested by ${p.actor}${p.note ? `: "${p.note}"` : ''}`, data: { stage: p.stage },
  }),

  jiraSkipped: (p: { target: string; from: string }): EventDraft => ({
    level: 'warn', source: 'jira', type: 'jira', message: `Jira transition to "${p.target}" skipped: not available from "${p.from}"`, errorCode: 'JIRA_ERROR',
  }),

  workerStarted: (p: { version: string; pid: number }): EventDraft => ({ level: 'info', source: 'system', type: 'worker', message: `Worker started (version ${p.version}, pid ${p.pid})` }),
  workerRestarting: (): EventDraft => ({ level: 'error', source: 'system', type: 'error', message: 'Worker is restarting repeatedly' }),
  paused: (p: { reason: string; code?: ErrorCode }): EventDraft => ({ level: 'warn', source: p.code?.startsWith('CLAUDE') ? 'claude' : 'system', type: 'usage', message: `Pipeline paused: ${p.reason}`, errorCode: p.code }),
  resumed: (p: { why: string }): EventDraft => ({ level: 'info', source: 'system', type: 'usage', message: `Pipeline resumed: ${p.why}` }),
  /** For a sentence that has no helper yet: still goes through here, so source and level are always set. */
  note: (p: { source: EventSource; type: string; message: string; level?: EventLevel }): EventDraft => ({ level: p.level ?? 'info', source: p.source, type: p.type, message: p.message }),
};
