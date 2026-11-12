export type LogKind = 'system' | 'assistant' | 'tool' | 'result' | 'error' | 'text';

export interface LogEntry {
  kind: LogKind;
  text: string;
}

const MAX_TOOL_TEXT = 300;

const clip = (text: string, max = MAX_TOOL_TEXT): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function blocks(message: unknown): unknown[] {
  return isObject(message) && Array.isArray(message.content) ? message.content : [];
}

/** Turns one stream-json log line into something readable. Unknown or non-JSON lines are shown as they are. */
export function formatLogLine(line: string): LogEntry | null {
  if (!line.startsWith('{')) return { kind: 'text', text: line };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'text', text: line };
  }
  if (!isObject(value)) return { kind: 'text', text: line };

  switch (value.type) {
    case 'system':
      if (value.subtype === 'init') {
        return { kind: 'system', text: `Started${typeof value.model === 'string' ? ` · ${value.model}` : ''}${typeof value.claude_code_version === 'string' ? ` · Claude Code ${value.claude_code_version}` : ''}` };
      }
      return null; // other system events are noise
    case 'assistant': {
      const parts: string[] = [];
      for (const b of blocks(value.message)) {
        if (!isObject(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
        else if (b.type === 'tool_use') parts.push(`→ ${String(b.name)} ${clip(JSON.stringify(b.input ?? {}))}`);
      }
      if (parts.length === 0) return null;
      const onlyTools = parts.every((p) => p.startsWith('→ '));
      return { kind: onlyTools ? 'tool' : 'assistant', text: parts.join('\n') };
    }
    case 'user': {
      const out: string[] = [];
      for (const b of blocks(value.message)) {
        if (isObject(b) && b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          out.push(`← ${clip(content)}`);
        }
      }
      return out.length > 0 ? { kind: 'tool', text: out.join('\n') } : null;
    }
    case 'result': {
      const turns = typeof value.num_turns === 'number' ? ` · ${value.num_turns} turns` : '';
      const cost = typeof value.total_cost_usd === 'number' ? ` · $${value.total_cost_usd.toFixed(4)}` : '';
      return { kind: value.is_error === true ? 'error' : 'result', text: `Result: ${String(value.subtype ?? 'done')}${turns}${cost}` };
    }
    default:
      return null;
  }
}
