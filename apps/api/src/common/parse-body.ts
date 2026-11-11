import { HttpStatus } from '@nestjs/common';
import { ErrorCodes, zodFields } from '@sdlc/shared';
import type { z } from 'zod';
import { ApiException } from './api-exception';

/** Validates a request body with a Zod schema; failures become a 400 with field-level errors. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown, message = 'Validation failed'): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, message, zodFields(result.error));
  }
  return result.data;
}
