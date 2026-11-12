import { randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

const normalise = (code: string) => code.toUpperCase().replace(/[-\s]/g, '');

/**
 * The one-time code that lets the first visitor create the admin password. It exists only while there is no admin
 * and no DASHBOARD_PASSWORD. A generated code is logged once (and deliberately not redacted).
 */
@Injectable()
export class SetupCodeService implements OnModuleInit {
  private readonly logger = new Logger(SetupCodeService.name);
  private code: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.dashboardPassword || (await this.prisma.adminAccount.count()) > 0) return;
    const fromEnv = process.env.SETUP_CODE?.trim();
    this.code = fromEnv || generateSetupCode();
    if (!fromEnv) this.logger.warn(`First-run setup code: ${this.code} (open the dashboard to finish setup)`);
  }

  /** Called once an admin exists: the code stops working. */
  expire(): void {
    this.code = null;
  }

  matches(input: string): boolean {
    if (!this.code) return false;
    const a = Buffer.from(normalise(input));
    const b = Buffer.from(normalise(this.code));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
