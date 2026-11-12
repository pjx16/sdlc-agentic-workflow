import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfig } from '../config';

/** The single dashboard password: hashed with argon2 at startup, compared with argon2 verify. */
@Injectable()
export class AuthService implements OnModuleInit {
  private passwordHash = '';

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    this.passwordHash = await argon2.hash(this.config.dashboardPassword);
  }

  verifyPassword(candidate: string): Promise<boolean> {
    return argon2.verify(this.passwordHash, candidate);
  }
}
