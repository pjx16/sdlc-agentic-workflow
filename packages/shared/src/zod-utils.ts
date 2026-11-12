import type { z } from 'zod';

/** Flattens a ZodError into `{ "settings.stages.plan.maxTurns": "message" }` (first message per path). */
export function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) fields[[...issue.path, k].map(String).join('.')] ??= 'unknown field';
      continue;
    }
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : 'body';
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recursively merges `patch` into `base`; arrays and scalars in `patch` replace the base value. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
