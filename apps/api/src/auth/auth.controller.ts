import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ErrorCodes } from '@sdlc/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { AppConfig } from '../config';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './constants';
import { LoginLimiter } from './login-limiter';
import { SESSION_TTL_MS, SessionService } from './session.service';



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

    const parsed = LoginBody.safeParse(body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? 'body')] = issue.message;
      throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Invalid login request', fields);
    }

    if (!(await this.auth.verifyPassword(parsed.data.password))) {
      this.limiter.recordFailure(ip);
      throw new ApiException(HttpStatus.UNAUTHORIZED, ErrorCodes.unauthorized, 'Wrong password');
    }

    this.limiter.recordSuccess(ip);
    const token = await this.sessions.create(ip);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
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
