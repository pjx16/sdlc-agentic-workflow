import { stageEnvelopeSchema, zodFields, type StageEnvelope, type StageName } from '@sdlc/shared';

export interface RateLimit {
  /** Percent of the 5-hour window used (0-100), or null when the event had no figure. */
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  status: string | null;
  resetsAt: Date | null;
  /** Every window of the event as sent (kept so per-model weekly windows are not dropped). */
  windows?: Record<string, unknown> | null;
}

export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  sessionId: string | null;
  cliVersion: string | null;
}

export type ParseKind =
  | 'ok' // a valid envelope
  | 'no_result' // the stream had no result line
  | 'turn_limit' // ended because of --max-turns
  | 'error' // the CLI reported an error (is_error)
  | 'invalid_output'; // no structured output, or it failed validation

export interface ParsedStream {
  kind: ParseKind;
  envelope?: StageEnvelope;
  /** Field-level validation messages for `invalid_output`. */
  fieldErrors?: Record<string, string>;
  /** Human-readable reason for any non-ok kind. */
  error?: string;
  usage: StageUsage;
  /** The latest rate_limit_event of the run (kept for the usage gate). */
  rateLimit: RateLimit | null;
  /** The raw `result` line, for resultJson. */
  result: Record<string, unknown> | null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The CLI reports utilization as a 0-1 fraction (SPIKE.md 0.2). Values above 1 are taken as percent already. */
export function toPercent(utilization: unknown): number | null {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  return utilization <= 1 ? utilization * 100 : utilization;
}

function parseRateLimit(event: Json): RateLimit {
  const info = isObject(event.rate_limit_info) ? event.rate_limit_info : {};
  const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
  const pick = (name: string) => (isObject(windows[name]) ? (windows[name] as Json).utilization : undefined);
  const resets = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null;
  return {
    fiveHourPct: toPercent(pick('five_hour')),
    sevenDayPct: toPercent(pick('seven_day')),
    status: typeof info.status === 'string' ? info.status : null,
    resetsAt: resets,
    windows: Object.keys(windows).length > 0 ? windows : null,
  };
}

/** The last fenced JSON block in a text (the fallback when structured_output is missing). */
export function lastFencedJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse((blocks[i] as RegExpMatchArray)[1] as string);
    } catch {
      /* try the previous block */
    }
  }
  return undefined;
}

export function parseStream(lines: readonly string[], stage: StageName): ParsedStream {
  let init: Json | null = null;
  let result: Json | null = null;
  let rateLimitEvent: Json | null = null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(value)) continue;
    if (value.type === 'system' && value.subtype === 'init') init = value;
    else if (value.type === 'result') result = value;
    else if (value.type === 'rate_limit_event') rateLimitEvent = value;
  }

  const usageObj = result && isObject(result.usage) ? result.usage : {};
  const usage: StageUsage = {
    inputTokens: num(usageObj.input_tokens),
    outputTokens: num(usageObj.output_tokens),
    cacheReadTokens: num(usageObj.cache_read_input_tokens),
    cacheWriteTokens: num(usageObj.cache_creation_input_tokens),
    costUsd: num(result?.total_cost_usd),
    numTurns: num(result?.num_turns),
    durationMs: num(result?.duration_ms),
    sessionId: typeof result?.session_id === 'string' ? result.session_id : typeof init?.session_id === 'string' ? init.session_id : null,
    cliVersion: typeof init?.claude_code_version === 'string' ? init.claude_code_version : null,
  };
  const rateLimit = rateLimitEvent ? parseRateLimit(rateLimitEvent) : null;
  const base = { usage, rateLimit, result };

  if (!result) return { ...base, kind: 'no_result', error: 'The run produced no result line' };

  if (result.subtype === 'error_max_turns' || result.terminal_reason === 'max_turns') {
    return { ...base, kind: 'turn_limit', error: 'The stage reached its turn limit' };
  }
  if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) {
    const errors = Array.isArray(result.errors) ? result.errors.join('; ') : '';
    const text = typeof result.result === 'string' ? result.result : '';
    return { ...base, kind: 'error', error: errors || text || `The CLI reported an error (${String(result.subtype)})` };
  }

  const candidate = isObject(result.structured_output)
    ? result.structured_output
    : typeof result.result === 'string'
      ? lastFencedJson(result.result)
      : undefined;
  if (candidate === undefined) {
    return { ...base, kind: 'invalid_output', error: 'No structured output and no fenced JSON block in the result' };
  }
  const parsed = stageEnvelopeSchema(stage).safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors = zodFields(parsed.error);
    return { ...base, kind: 'invalid_output', fieldErrors, error: `Output failed validation: ${Object.entries(fieldErrors).map(([k, v]) => `${k}: ${v}`).join('; ')}` };
  }
  return { ...base, kind: 'ok', envelope: parsed.data as StageEnvelope };
}

/** A rate-limit rejection, from the event or from the CLI's error (BUILD_PLAN 6.8: pause, re-queue, no attempt). */
export function isRateLimited(parsed: ParsedStream): boolean {
  if (parsed.rateLimit?.status === 'rejected') return true;
  const r = parsed.result;
  if (r?.api_error_status === 429) return true;
  return parsed.kind === 'error' && /usage limit|rate.?limit/i.test(parsed.error ?? '');
}
