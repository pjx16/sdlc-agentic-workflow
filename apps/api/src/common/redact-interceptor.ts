import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { type Observable, map } from 'rxjs';
import { createRedactor } from './redact';

/** Replaces known secrets and token-shaped strings in every string of a JSON value, leaving its structure alone. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T;
  }
  return value; // numbers, booleans, null, Dates and class instances (serialised later) are left as they are
}

/**
 * Secrets are redacted from everything the dashboard shows (BUILD_PLAN 13). Logs are redacted when they are written; this covers the
 * rest: events, error messages and run errors stored by the worker, and anything else an API response carries.
 */
@Injectable()
export class RedactInterceptor implements NestInterceptor {
  private readonly redact: (text: string) => string;

  constructor(secrets: readonly (string | undefined)[]) {
    this.redact = createRedactor(secrets);
  }

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => redactDeep(body, this.redact)));
  }
}

/** The secrets the API process itself holds (the tokens of the worker are covered by their shapes). */
export const apiSecrets = (env: NodeJS.ProcessEnv = process.env): (string | undefined)[] => [env.JIRA_API_TOKEN, env.JIRA_MCP_AUTH, env.SESSION_SECRET, env.DASHBOARD_PASSWORD, env.POSTGRES_PASSWORD, env.GITHUB_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN];
