/** Small helpers for the settings forms: dotted-path access, and number/text conversion at the API boundary. */

export type FormValues = Record<string, unknown>;

export function getIn(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setIn<T extends FormValues>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const key = head as string;
  const child = (obj as Record<string, unknown>)[key];
  return {
    ...obj,
    [key]: rest.length === 0 ? value : setIn((child && typeof child === 'object' ? child : {}) as FormValues, rest.join('.'), value),
  };
}

/** Inputs hold text, so numbers become strings in form state. */
export function stringifyNumbers<T>(value: T): T {
  if (typeof value === 'number') return String(value) as unknown as T;
  if (Array.isArray(value)) return value.map(stringifyNumbers) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringifyNumbers(v)])) as T;
  }
  return value;
}

/** Empty text is sent as null, so the API reports "must be a number" instead of silently using a default. */
export function toNumber(text: unknown): number | null {
  if (typeof text === 'number') return text;
  const trimmed = String(text ?? '').trim();
  return trimmed === '' ? null : Number(trimmed);
}

export function splitLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}
