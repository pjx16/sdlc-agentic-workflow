import { describe, expect, it } from 'vitest';
import { isRateLimited, lastFencedJson, parseStream, toPercent } from './result-parser';

const init = { type: 'system', subtype: 'init', claude_code_version: '2.1.322', session_id: 's-init' };
const planData = { planMarkdown: '# Plan', risks: [], openQuestions: [] };
const envelope = (over: Record<string, unknown> = {}) => ({ status: 'done', summary: 'ok', data: planData, ...over });
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };
const result = (over: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 1234, total_cost_usd: 0.0123, session_id: 's-1', usage,
  result: 'done', structured_output: envelope(), ...over,
});
const rate = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1794418200, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1794418200, status: 'allowed' }, seven_day: { utilization: 0.08, resetsAt: 1794740400, status: 'allowed' } } } };
const lines = (...objs: unknown[]) => objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o)));

describe('parseStream (BUILD_PLAN 6.4)', () => {
  it('reads structured_output from the last result line, with tokens, cost, turns, session and CLI version', () => {
    const p = parseStream(lines(init, { type: 'assistant' }, rate, result()), 'plan');
    expect(p.kind).toBe('ok');
    expect(p.envelope).toMatchObject({ status: 'done', data: planData });
    expect(p.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, costUsd: 0.0123, numTurns: 3, durationMs: 1234, sessionId: 's-1', cliVersion: '2.1.322' });
  });

  it('keeps only the latest rate_limit_event, scaled to percent', () => {
    const later = { ...rate, rate_limit_info: { ...rate.rate_limit_info, unifiedWindows: { five_hour: { utilization: 0.6 }, seven_day: { utilization: 0.1 } } } };
    const p = parseStream(lines(init, rate, later, result()), 'plan');
    expect(p.rateLimit).toMatchObject({ fiveHourPct: 60, sevenDayPct: 10, status: 'allowed' });
    expect(p.rateLimit?.resetsAt?.getTime()).toBe(1794418200 * 1000);
    expect(parseStream(lines(init, result()), 'plan').rateLimit).toBeNull();
  });

  it('falls back to the last fenced JSON block in the result text', () => {
    const text = `Here is a draft:\n\`\`\`json\n{"status":"blocked","summary":"old"}\n\`\`\`\nFinal:\n\`\`\`json\n${JSON.stringify(envelope())}\n\`\`\``;
    const p = parseStream(lines(init, result({ structured_output: undefined, result: text })), 'plan');
    expect(p.kind).toBe('ok');
    expect(p.envelope?.summary).toBe('ok');
  });

  it('uses the last result line when there are several, and ignores non-JSON lines', () => {
    const p = parseStream(lines('warning: something', init, result({ structured_output: envelope({ summary: 'first' }) }), 'not json {', result({ structured_output: envelope({ summary: 'second' }) })), 'plan');
    expect(p.envelope?.summary).toBe('second');
  });

  it('reports invalid output with field-level errors', () => {
    const p = parseStream(lines(init, result({ structured_output: envelope({ data: { planMarkdown: '' } }) })), 'plan');
    expect(p.kind).toBe('invalid_output');
    expect(p.fieldErrors).toMatchObject({ 'data.planMarkdown': 'must not be empty' });
    expect(p.error).toContain('data.planMarkdown');
  });

  it('reports a missing structured output and a missing result line', () => {
    expect(parseStream(lines(init, result({ structured_output: undefined, result: 'just prose' })), 'plan').kind).toBe('invalid_output');
    expect(parseStream(lines(init, { type: 'assistant' }), 'plan')).toMatchObject({ kind: 'no_result' });
    expect(parseStream([], 'plan').kind).toBe('no_result');
  });

  it('recognises the turn limit (SPIKE.md 0.4)', () => {
    const p = parseStream(lines(init, { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 3, terminal_reason: 'max_turns', result: null, errors: ['Reached maximum number of turns (2)'] }), 'plan');
    expect(p.kind).toBe('turn_limit');
    expect(p.usage.numTurns).toBe(3);
  });

  it('reports other CLI errors with their message', () => {
    const p = parseStream(lines(init, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }), 'plan');
    expect(p).toMatchObject({ kind: 'error', error: 'boom' });
  });

  it('validates needs_input and blocked envelopes', () => {
    expect(parseStream(lines(init, result({ structured_output: { status: 'needs_input', summary: 'q', question: 'Which?' } })), 'plan').envelope?.question).toBe('Which?');
    expect(parseStream(lines(init, result({ structured_output: { status: 'needs_input', summary: 'q' } })), 'plan').kind).toBe('invalid_output');
  });
});

describe('rate limits', () => {
  it('detects a rejected status, a 429, and a usage-limit error', () => {
    const rejected = { ...rate, rate_limit_info: { ...rate.rate_limit_info, status: 'rejected' } };
    expect(isRateLimited(parseStream(lines(init, rejected, result()), 'plan'))).toBe(true);
    expect(isRateLimited(parseStream(lines(init, { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, errors: ['x'] }), 'plan'))).toBe(true);
    expect(isRateLimited(parseStream(lines(init, { type: 'result', subtype: 'error', is_error: true, result: 'Claude usage limit reached' }), 'plan'))).toBe(true);
    expect(isRateLimited(parseStream(lines(init, rate, result()), 'plan'))).toBe(false);
  });
  it('scales utilization: fractions to percent, larger values kept', () => {
    expect(toPercent(0.42)).toBeCloseTo(42);
    expect(toPercent(1)).toBe(100);
    expect(toPercent(55)).toBe(55);
    expect(toPercent(undefined)).toBeNull();
  });
});

describe('lastFencedJson', () => {
  it('skips blocks that are not valid JSON', () => {
    expect(lastFencedJson('```json\n{"a":1}\n```\n```\nnot json\n```')).toEqual({ a: 1 });
    expect(lastFencedJson('no blocks')).toBeUndefined();
  });
});
