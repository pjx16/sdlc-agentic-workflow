import { HttpException } from '@nestjs/common';
import type { ErrorBody } from '@sdlc/shared';

/** Throw this from any handler to produce the shared error body. */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    const body: ErrorBody = { error: code, message, ...(fields ? { fields } : {}) };
    super(body, status);
  }
}
