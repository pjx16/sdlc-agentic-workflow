import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ChangePasswordBodySchema, ErrorCodes, SetupAdminBodySchema, type SetupStatus } from '@sdlc/shared';
import type { Request, Response } from 'express';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { AppConfig } from '../config';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/constants';
import { LoginLimiter } from '../auth/login-limiter';
import { setSessionCookie } from '../auth/session-cookie';
import { SessionService } from '../auth/session.service';
import { CredentialsService } from '../credentials/credentials.service';
import { SetupCodeService } from './setup-code.service';

@Controller()
export class SetupController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly limiter: LoginLimiter,
    private readonly codes: SetupCodeService,
    private readonly creds: CredentialsService,
    private readonly config: AppConfig,
  ) {}

  /** Public. Without a session only `adminCreated` is revealed. */
  @Get('setup/status')
  async status(@Req() req: Request): Promise<Pick<SetupStatus, 'adminCreated'> | SetupStatus> {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token && (await this.sessions.isValid(token))) return this.creds.status();
    return { adminCreated: await this.auth.hasAdmin() };
  }

  /** Public, protected by the one-time setup code and the login limiter. */
  @Post('setup/admin')
  @HttpCode(HttpStatus.OK)
  async createAdmin(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    if (await this.auth.hasAdmin()) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The admin account already exists');
    const ip = req.ip ?? 'unknown';
    const locked = this.limiter.lockedForSeconds(ip);
    if (locked > 0) {
      res.setHeader('Retry-After', String(locked));
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.tooManyRequests, 'Too many failed attempts. Try again later.');
    }
    const input = parseBody(SetupAdminBodySchema, body ?? {}, 'Invalid setup request');
    if (!this.codes.matches(input.setupCode)) {
      this.limiter.recordFailure(ip);
      throw new ApiException(HttpStatus.UNAUTHORIZED, ErrorCodes.unauthorized, 'Wrong setup code');
    }
    await this.auth.setAdminPassword(input.password);
    this.codes.expire();
    this.limiter.recordSuccess(ip);
    setSessionCookie(res, await this.sessions.create(ip), this.config.cookieSecure);
    return { ok: true };
  }

  @Post('auth/password')
  @HttpCode(HttpStatus.OK)
  async changePassword(@Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    if (this.auth.passwordFromEnv()) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The password is set by DASHBOARD_PASSWORD in .env');
    const input = parseBody(ChangePasswordBodySchema, body ?? {}, 'Invalid request');
    if (!(await this.auth.verifyPassword(input.current))) throw new ApiException(HttpStatus.UNAUTHORIZED, ErrorCodes.unauthorized, 'The current password is wrong');
    await this.auth.setAdminPassword(input.next);
    await this.sessions.destroyOthers(req.cookies?.[SESSION_COOKIE] as string);
    return { ok: true };
  }
}
