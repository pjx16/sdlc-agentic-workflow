import { HttpStatus, Injectable, type NestMiddleware } from '@nestjs/common';
import { ErrorCodes } from '@sdlc/shared';
import type { NextFunction, Request, Response } from 'express';
import { ApiException } from '../common/api-exception';
import { SESSION_COOKIE } from './constants';
import { SessionService } from './session.service';

/** The only routes reachable without a session (F1). Anything else, including unknown routes, needs one. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/auth/login', '/health']);

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly sessions: SessionService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const path = req.path.replace(/\/+$/, '') || '/';
      if (PUBLIC_PATHS.has(path)) return next();
      const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
      if (token && (await this.sessions.isValid(token))) return next();
      throw new ApiException(HttpStatus.UNAUTHORIZED, ErrorCodes.unauthorized, 'Authentication required');
    } catch (err) {
      next(err);
    }
  }
}
