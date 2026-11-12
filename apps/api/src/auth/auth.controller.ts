import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ErrorCodes } from '@sdlc/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { AppConfig } from '../config';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './constants';
import { LoginLimiter } from './login-limiter';
import { setSessionCookie } from './session-cookie';
import { SessionService } from './session.service';



const LoginBody = z.object({ password: z.string({ error: 'required' }).min(1, 'required') });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly limiter: LoginLimiter,
    private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const ip = req.ip ?? 'unknown';
    const locked = this.limiter.lockedForSeconds(ip);
    if (locked > 0) {
      res.setHeader('Retry-After', String(locked));
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.tooManyRequests, 'Too many failed logins. Try again later.');
    }

    const input = parseBody(LoginBody, body ?? {}, 'Invalid login request');

    if (!(await this.auth.verifyPassword(input.password))) {
      this.limiter.recordFailure(ip);
      throw new ApiException(HttpStatus.UNAUTHORIZED, ErrorCodes.unauthorized, 'Wrong password');
    }

    this.limiter.recordSuccess(ip);
    setSessionCookie(res, await this.sessions.create(ip), this.config.cookieSecure);
    return { ok: true };
  }

  /** Lets the dashboard check a session cookie. The session middleware answers 401 when it is not valid. */
  @Get('session')
  session(): { ok: true } {
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) await this.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
