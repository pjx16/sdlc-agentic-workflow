/** Atlassian Document Format conversion (BUILD_PLAN 6.3). Supported: headings, paragraphs, bullet and ordered lists, fenced code blocks. */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const text = (value: string): AdfNode => ({ type: 'text', text: value });

/** Lines of a paragraph become text nodes separated by hard breaks. Inline code stays plain text. */
function inline(lines: string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push({ type: 'hardBreak' });
    if (line.length > 0) nodes.push(text(line));
  });
  return nodes;
}

const listItem = (content: string): AdfNode => ({ type: 'listItem', content: [{ type: 'paragraph', content: content ? [text(content)] : [] }] });

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) content.push({ type: 'paragraph', content: inline(paragraph) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] as string)) code.push(lines[i++] as string);
      const node: AdfNode = { type: 'codeBlock', content: code.length > 0 ? [text(code.join('\n'))] : [] };
      if (fence[1]) node.attrs = { language: fence[1] };
      content.push(node);
      continue; // i now points at the closing fence (or the end)
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      content.push({ type: 'heading', attrs: { level: (heading[1] as string).length }, content: [text(heading[2] as string)] });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? 'bulletList' : 'orderedList';
      const items: AdfNode[] = [];
      const pattern = bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      while (i < lines.length) {
        const m = pattern.exec(lines[i] as string);
        if (!m) break;
        items.push(listItem((m[1] as string).trim()));
        i++;
      }
      i--;
      content.push({ type, content: items });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return { type: 'doc', version: 1, content };
}

function inlineText(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      const link = node.marks?.find((m) => m.type === 'link');
      const href = link?.attrs?.href;
      return typeof href === 'string' && href !== node.text ? `${node.text ?? ''} (${href})` : (node.text ?? '');
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(node.attrs?.url ?? '');
    default:
      // Unknown node: contribute its plain text, and whatever is inside it.
      return node.text ?? (node.content ?? []).map(inlineText).join('');
  }
}

const inlines = (nodes: AdfNode[] | undefined) => (nodes ?? []).map(inlineText).join('');

function block(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return inlines(node.content);
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inlines(node.content)}`;
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      return `\`\`\`${language}\n${inlines(node.content)}\n\`\`\``;
    }
    case 'bulletList':
      return (node.content ?? []).map((item) => `- ${listItemText(item)}`).join('\n');
    case 'orderedList':
      return (node.content ?? []).map((item, i) => `${i + 1}. ${listItemText(item)}`).join('\n');
    case 'rule':
      return '---';
    case 'blockquote':
      return (node.content ?? []).map(block).join('\n').split('\n').map((l) => `> ${l}`).join('\n');
    default:
      // Unknown block (panel, table, media, ...): the plain text of its children.
      return node.content ? (node.content.some((c) => isBlockType(c.type)) ? node.content.map(block).join('\n\n') : inlines(node.content)) : (node.text ?? '');
  }
}

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'bulletList', 'orderedList', 'rule', 'blockquote', 'panel', 'table', 'tableRow', 'tableCell', 'tableHeader', 'expand']);
const isBlockType = (t: string) => BLOCKS.has(t);

function listItemText(item: AdfNode): string {
  return (item.content ?? []).map(block).join('\n').split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n');
}

/** ADF to readable markdown-ish text. Anything unknown contributes its plain text; null or malformed input gives ''. */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc; // Jira API v2 style plain text
  if (!doc || typeof doc !== 'object') return '';
  const root = doc as AdfNode;
  const nodes = root.type === 'doc' ? (root.content ?? []) : [root];
  return nodes.map(block).filter((s) => s.length > 0).join('\n\n').trim();
}
