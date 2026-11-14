import { describe, expect, it } from 'vitest';
import { MESSAGES_BEFORE_SUMMARY, RECENT_MESSAGES, summarize, windowOf } from './assistant-runner';
import { planDiff } from './context-pack';

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: `message ${i + 1} ${'x'.repeat(300)}` }));

describe('windowOf: what goes into the prompt', () => {
  it('sends the whole conversation while it is short, and may continue the CLI session', () => {
    const w = windowOf(msgs(MESSAGES_BEFORE_SUMMARY - 1)); // plus the new message makes 10
    expect(w.summary).toBeNull();
    expect(w.history).toHaveLength(MESSAGES_BEFORE_SUMMARY - 1);
    expect(w.canResume).toBe(true);
  });

  it('after 10 messages, older turns become a short summary and only the latest few stay word for word', () => {
    const w = windowOf(msgs(MESSAGES_BEFORE_SUMMARY)); // plus the new message makes 11
    expect(w.history).toHaveLength(RECENT_MESSAGES);
    expect(w.history.at(-1)?.text).toContain(`message ${MESSAGES_BEFORE_SUMMARY} `);
    expect(w.summary).toContain('Person: message 1');
    expect(w.summary).not.toContain(`message ${MESSAGES_BEFORE_SUMMARY} `);
    expect(w.canResume).toBe(false); // the session still holds the old turns: start a fresh one
  });

  it('keeps the summary short however long the conversation is', () => {
    const w = windowOf(msgs(200));
    expect((w.summary ?? '').length).toBeLessThanOrEqual(2000);
    expect(w.history).toHaveLength(RECENT_MESSAGES);
  });
});

describe('summarize', () => {
  it('says who spoke and cuts each message to its first words', () => {
    const s = summarize([{ role: 'user', text: 'Why  is\nthe plan so long? ' + 'y'.repeat(500) }, { role: 'assistant', text: 'Because.' }]);
    const lines = s.split('\n');
    expect(lines[0]?.startsWith('Person: Why is the plan so long?')).toBe(true);
    expect(lines[0]?.length).toBeLessThanOrEqual('Person: '.length + 160);
    expect(lines[1]).toBe('Assistant: Because.');
  });
});

describe('planDiff', () => {
  it('marks lines removed and added', () => {
    expect(planDiff('## Goal\nExport CSV\n## Risks\n- slow', '## Goal\nExport CSV and XLSX\n## Risks\n- slow')).toBe('- Export CSV\n+ Export CSV and XLSX');
  });
  it('says so when nothing changed', () => expect(planDiff('a\nb', 'a\nb')).toBe('(no change)'));
});
