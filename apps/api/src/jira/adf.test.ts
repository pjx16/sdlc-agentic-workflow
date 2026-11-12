import { describe, expect, it } from 'vitest';
import { adfToText, markdownToAdf } from './adf';

describe('markdownToAdf (BUILD_PLAN 6.3)', () => {
  it('makes paragraphs, with hard breaks inside a paragraph', () => {
    expect(markdownToAdf('First line\nsecond line\n\nNew paragraph').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'New paragraph' }] },
    ]);
  });

  it('makes headings of every level', () => {
    const doc = markdownToAdf('# One\n### Three ###\n###### Six');
    expect(doc.content.map((n) => [n.type, n.attrs?.level, n.content?.[0]?.text])).toEqual([['heading', 1, 'One'], ['heading', 3, 'Three'], ['heading', 6, 'Six']]);
  });

  it('makes bullet and ordered lists', () => {
    const doc = markdownToAdf('- a\n* b\n+ c\n\n1. one\n2) two');
    expect(doc.content[0]).toMatchObject({ type: 'bulletList' });
    expect(doc.content[0]?.content).toHaveLength(3);
    expect(doc.content[0]?.content?.[1]).toEqual({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] });
    expect(doc.content[1]).toMatchObject({ type: 'orderedList' });
    expect(doc.content[1]?.content).toHaveLength(2);
  });

  it('makes fenced code blocks, keeping content verbatim and the language', () => {
    const doc = markdownToAdf('Before\n```ts\nconst a = 1;\n\n  indented\n```\nAfter');
    expect(doc.content.map((n) => n.type)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
    expect(doc.content[1]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;\n\n  indented' }] });
  });

  it('leaves inline code as plain text, and does not treat markers inside code blocks as structure', () => {
    expect(markdownToAdf('Use `npm ci` now').content[0]?.content?.[0]?.text).toBe('Use `npm ci` now');
    const doc = markdownToAdf('```\n# not a heading\n- not a list\n```');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.type).toBe('codeBlock');
  });

  it('handles an unterminated fence, CRLF, and empty input', () => {
    expect(markdownToAdf('```\nopen').content[0]).toMatchObject({ type: 'codeBlock' });
    expect(markdownToAdf('a\r\n\r\nb').content).toHaveLength(2);
    expect(markdownToAdf('')).toEqual({ type: 'doc', version: 1, content: [] });
  });

  it('is a valid doc', () => {
    const d = markdownToAdf('x');
    expect(d.type).toBe('doc');
    expect(d.version).toBe(1);
  });
});

describe('adfToText (BUILD_PLAN 6.3)', () => {
  const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
  const p = (...content: unknown[]) => ({ type: 'paragraph', content });
  const t = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });

  it('converts headings, paragraphs, lists and code blocks', () => {
    const adf = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Title')] },
      p(t('Hello '), t('world')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a'))] }, { type: 'listItem', content: [p(t('b'))] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('x'))] }, { type: 'listItem', content: [p(t('y'))] }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [t('let a = 1;')] },
    );
    expect(adfToText(adf)).toBe('## Title\n\nHello world\n\n- a\n- b\n\n1. x\n2. y\n\n```js\nlet a = 1;\n```');
  });

  it('writes links as text with the URL', () => {
    expect(adfToText(doc(p(t('see the docs', [{ type: 'link', attrs: { href: 'https://example.com/x' } }]))))).toBe('see the docs (https://example.com/x)');
    expect(adfToText(doc(p(t('https://a.b', [{ type: 'link', attrs: { href: 'https://a.b' } }]))))).toBe('https://a.b');
  });

  it('turns hard breaks into newlines', () => {
    expect(adfToText(doc(p(t('a'), { type: 'hardBreak' }, t('b'))))).toBe('a\nb');
  });

  it('lets unknown nodes contribute their plain text', () => {
    expect(adfToText(doc(p(t('Ping '), { type: 'mention', attrs: { id: '1', text: '@sam' } }), { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Heads up'))] }, p({ type: 'somethingNew', content: [t('inside')] })))).toBe('Ping @sam\n\nHeads up\n\ninside');
  });

  it('handles nested lists, blockquotes, rules and cards', () => {
    const nested = { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('parent')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('child'))] }] }] }] };
    expect(adfToText(doc(nested))).toBe('- parent\n  - child');
    expect(adfToText(doc({ type: 'blockquote', content: [p(t('quoted'))] }, { type: 'rule' }))).toBe('> quoted\n\n---');
    expect(adfToText(doc(p({ type: 'inlineCard', attrs: { url: 'https://jira/x' } })))).toBe('https://jira/x');
  });

  it('is safe for null, plain strings and malformed input', () => {
    expect(adfToText(null)).toBe('');
    expect(adfToText(undefined)).toBe('');
    expect(adfToText('plain text')).toBe('plain text');
    expect(adfToText(42)).toBe('');
    expect(adfToText({ type: 'doc' })).toBe('');
    expect(adfToText(doc({ type: 'paragraph' }))).toBe('');
  });

  it('round-trips the supported markdown', () => {
    const md = '# Title\n\nSome text\nwith a break\n\n- a\n- b\n\n1. one\n2. two\n\n```ts\nconst x = 1;\n```';
    expect(adfToText(markdownToAdf(md))).toBe(md);
  });
});
