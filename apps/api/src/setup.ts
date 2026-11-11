import type { INestApplication } from '@nestjs/common';
import { ErrorFilter } from './common/error.filter';

/** Shared by main.ts and the tests so both behave the same. */
export function configureApp(app: INestApplication): void {
  app.useGlobalFilters(new ErrorFilter());
}
