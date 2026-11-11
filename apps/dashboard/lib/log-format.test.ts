import { describe, expect, it } from 'vitest';
import { formatLogLine } from './log-format';

const line = (o: unknown) => JSON.stringify(o);

describe('formatLogLine', () => {
  it('shows plain text as it is', () => {
    expect(formatLogLine('warning: something')).toEqual({ kind: 'text', text: 'warning: something' });
    expect(formatLogLine('{ not json')).toEqual({ kind: 'text', text: '{ not json' });
  });

  it('summarises the init line', () => {
    expect(formatLogLine(line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', claude_code_version: '2.1.322' }))).toEqual({ kind: 'system', text: 'Started · claude-opus-5-5 · Claude Code 2.1.322' });
  });

  it('shows assistant text and tool calls', () => {
    expect(formatLogLine(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the repo' }] } }))).toEqual({ kind: 'assistant', text: 'Looking at the repo' });
    const tool = formatLogLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));
    expect(tool).toEqual({ kind: 'tool', text: '→ Bash {"command":"ls"}' });
  });

  it('truncates long tool results', () => {
    const result = formatLogLine(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(1000) }] } }));
    expect(result?.kind).toBe('tool');
    expect(result?.text.length).toBeLessThanOrEqual(302);
    expect(result?.text.endsWith('…')).toBe(true);
  });

  it('summarises results and marks errors', () => {
    expect(formatLogLine(line({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.0123 }))).toEqual({ kind: 'result', text: 'Result: success · 3 turns · $0.0123' });
    expect(formatLogLine(line({ type: 'result', subtype: 'error_max_turns', is_error: true }))?.kind).toBe('error');
  });

  it('hides noise', () => {
    expect(formatLogLine(line({ type: 'rate_limit_event' }))).toBeNull();
    expect(formatLogLine(line({ type: 'system', subtype: 'thinking_tokens' }))).toBeNull();
    expect(formatLogLine(line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }))).toBeNull();
  });
});
