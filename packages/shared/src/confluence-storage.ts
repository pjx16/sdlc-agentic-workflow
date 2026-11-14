/**
 * Markdown to Confluence storage format (BUILD_PLAN v1 6.10): headings, paragraphs, bullet and numbered lists, fenced code blocks,
 * tables, links, bold, italic, inline code, and `file:line` references as code. No AI involved; everything is escaped.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FILE_LINE = /(^|[\s(])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)(?=$|[\s).,;:])/g;

/** Inline markup of one line of text. */
export function inlineToStorage(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = s.replace(FILE_LINE, (_m, pre: string, ref: string) => `${pre}\u0000${codes.push(`<code>${esc(ref)}</code>`) - 1}\u0000`);
  const links: string[] = [];
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `\u0001${links.push(`<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(label)}</a>`) - 1}\u0001`);
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  // The \u0000 and \u0001 characters are private placeholder markers, so the control characters are intended.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)] ?? '').replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function markdownToStorage(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i++;
      const lang = fence[1] ? `<ac:parameter ac:name="language">${esc(fence[1])}</ac:parameter>` : '';
      out.push(`<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${body.join('\n').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<h${heading[1]?.length}>${inlineToStorage(heading[2] ?? '')}</h${heading[1]?.length}>`);
      i++;
      continue;
    }
    if (isTableRow(line) && isSeparator(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) rows.push(cells(lines[i++] ?? ''));
      out.push(`<table><tbody><tr>${head.map((c) => `<th>${inlineToStorage(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineToStorage(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+/.test(line);
    const numbered = /^\s*\d+[.)]\s+/.test(line);
    if (bullet || numbered) {
      const re = bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i] ?? '')) items.push(re.exec(lines[i++] ?? '')?.[1] ?? '');
      const tag = bullet ? 'ul' : 'ol';
      out.push(`<${tag}>${items.map((t) => `<li>${inlineToStorage(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i] ?? '') && !(isTableRow(lines[i] ?? '') && isSeparator(lines[i + 1] ?? ''))) para.push(lines[i++] ?? '');
    out.push(`<p>${para.map(inlineToStorage).join('<br/>')}</p>`);
  }
  return out.join('');
}
