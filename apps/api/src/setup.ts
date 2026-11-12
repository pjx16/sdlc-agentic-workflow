import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { ErrorCodes } from '@sdlc/shared';
import { ErrorFilter } from './common/error.filter';
import { CredentialsService } from './credentials/credentials.service';
import { RedactInterceptor, apiSecrets } from './common/redact-interceptor';

/** Shared by main.ts and the tests so both behave the same. */
export function configureApp(app: INestApplication): void {
  // The API sits behind the dashboard's /api rewrite, which adds X-Forwarded-For (one hop).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Browsers send Sec-Fetch-Site on every request; refuse writes coming from any other site, including other localhost ports.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const site = req.get('sec-fetch-site');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && site && site !== 'same-origin' && site !== 'none') {
      res.status(403).json({ error: ErrorCodes.forbidden, message: 'Cross-site request refused' });
      return;
    }
    next();
  });
  app.use(cookieParser());
  let creds: CredentialsService | undefined;
  try {
    creds = app.get(CredentialsService, { strict: false });
  } catch {
    creds = undefined; // modules built for a test without credentials
  }
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalInterceptors(new RedactInterceptor(() => [...apiSecrets(), ...(creds?.secretsSnapshot() ?? [])]));
}
