import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from './logging.module';

describe('request log redaction (S4)', () => {
  it('replaces the session cookie in request and response headers', () => {
    const lines: string[] = [];
    const logger = pino({ redact: LOG_REDACT_PATHS }, { write: (line: string) => void lines.push(line) });
    logger.info({
      req: { headers: { cookie: 'sdlc_session=SECRET-TOKEN', authorization: 'Bearer SECRET-TOKEN', host: 'x' } },
      res: { headers: { 'set-cookie': ['sdlc_session=SECRET-TOKEN; HttpOnly'], 'content-type': 'application/json' } },
    });
    expect(lines.join('')).not.toContain('SECRET-TOKEN');
    expect(lines.join('')).toContain('[Redacted]');
    expect(lines.join('')).toContain('application/json');
  });
});
