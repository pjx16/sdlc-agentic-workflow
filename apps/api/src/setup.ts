import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ErrorFilter } from './common/error.filter';

/** Shared by main.ts and the tests so both behave the same. */
export function configureApp(app: INestApplication): void {
  // The API sits behind the dashboard's /api rewrite, which adds X-Forwarded-For (one hop).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(cookieParser());
  app.useGlobalFilters(new ErrorFilter());
}
