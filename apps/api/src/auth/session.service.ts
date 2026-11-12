import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, type Clock } from './clock';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  /** Creates a session and returns the raw token. Only its SHA-256 is stored. */
  async create(ip: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.prisma.session.create({
      data: { tokenHash: hashToken(token), ip, expiresAt: new Date(this.now() + SESSION_TTL_MS) },
    });
    return token;
  }

  async isValid(token: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!session) return false;
    if (session.expiresAt.getTime() <= this.now()) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return false;
    }
    return true;
  }

  /** Logs out every session except the one holding `token`. */
  async destroyOthers(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: { not: hashToken(token) } } });
  }

  async destroy(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
}
