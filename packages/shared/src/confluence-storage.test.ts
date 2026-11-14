import { describe, expect, it } from 'vitest';
import { inlineToStorage, markdownToStorage } from './confluence-storage';

describe('markdownToStorage', () => {
  it('headings and paragraphs', () => {
    expect(markdownToStorage('# Title\n\nSome text\nsecond line')).toBe('<h1>Title</h1><p>Some text<br/>second line</p>');
    expect(markdownToStorage('### Deep')).toBe('<h3>Deep</h3>');
  });
  it('bullet and numbered lists', () => {
    expect(markdownToStorage('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToStorage('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });
  it('code blocks keep their text and language, and cannot break out of the CDATA', () => {
    expect(markdownToStorage('```ts\nconst a = 1 < 2;\n```')).toBe('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const a = 1 < 2;]]></ac:plain-text-body></ac:structured-macro>');
    expect(markdownToStorage('```\na ]]> b\n```')).toContain(']]]]><![CDATA[>');
  });
  it('tables', () => {
    expect(markdownToStorage('| A | B |\n| --- | --- |\n| 1 | 2 |')).toBe('<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
  });
  it('links, bold, italic and inline code', () => {
    expect(inlineToStorage('see [docs](https://x.test/a?b=1&c=2) and **bold** and *it* and `a<b`')).toBe('see <a href="https://x.test/a?b=1&amp;c=2">docs</a> and <strong>bold</strong> and <em>it</em> and <code>a&lt;b</code>');
  });
  it('file:line references become code, and plain text is escaped', () => {
    expect(inlineToStorage('see src/bookings/cancel.service.ts:42 for <b>it</b>')).toBe('see <code>src/bookings/cancel.service.ts:42</code> for &lt;b&gt;it&lt;/b&gt;');
    expect(inlineToStorage('version 1:30 is fine')).toBe('version 1:30 is fine');
  });
  it('a javascript link is not turned into a link', () => {
    expect(inlineToStorage('[x](javascript:alert(1))')).not.toContain('<a ');
  });
});
