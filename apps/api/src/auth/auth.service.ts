import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/** The single dashboard password: DASHBOARD_PASSWORD when set, otherwise the argon2 hash created in the setup wizard. */
@Injectable()
export class AuthService implements OnModuleInit {
  private envHash = '';

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.dashboardPassword) this.envHash = await argon2.hash(this.config.dashboardPassword);
  }

  /** True when the password comes from .env: the wizard's admin step and password change are then disabled. */
  passwordFromEnv(): boolean {
    return this.envHash !== '';
  }

  async hasAdmin(): Promise<boolean> {
    return this.passwordFromEnv() || (await this.prisma.adminAccount.count()) > 0;
  }

  async verifyPassword(candidate: string): Promise<boolean> {
    if (this.envHash) return argon2.verify(this.envHash, candidate);
    const admin = await this.prisma.adminAccount.findUnique({ where: { id: 'admin' } });
    if (!admin) return false;
    return argon2.verify(admin.passwordHash, candidate);
  }

  async setAdminPassword(password: string): Promise<void> {
    const passwordHash = await argon2.hash(password);
    await this.prisma.adminAccount.upsert({ where: { id: 'admin' }, update: { passwordHash }, create: { id: 'admin', passwordHash } });
  }
}
