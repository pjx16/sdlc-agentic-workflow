import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ErrorCodes, type ErrorBody } from '@sdlc/shared';
import type { Response } from 'express';
import { ApiException } from './api-exception';

const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: ErrorCodes.validation,
  [HttpStatus.UNAUTHORIZED]: ErrorCodes.unauthorized,
  [HttpStatus.NOT_FOUND]: ErrorCodes.notFound,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCodes.tooManyRequests,
};

/** Turns every thrown error into `{ error, message, fields? }`. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApiException) {
      const body: ErrorBody = { error: exception.code, message: exception.message };
      if (exception.fields) body.fields = exception.fields;
      return { status: exception.getStatus(), body };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: { error: CODE_BY_STATUS[status] ?? ErrorCodes.internal, message: exception.message },
      };
    }
    // Never leak internals for unexpected errors.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: ErrorCodes.internal, message: 'Internal server error' },
    };
  }
}
