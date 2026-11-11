import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MirrorService } from '../git/mirror.service';

/**
 * Loop skeleton. For now it only clones mirrors for pending projects; later milestones add picking tickets,
 * running stages and housekeeping to the same tick.
 */
@Injectable()
export class WorkerLoop {
  private readonly logger = new Logger(WorkerLoop.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mirrors: MirrorService,
  ) {}

  /** One pass: clone the mirror of every enabled project whose mirrorStatus is pending, oldest first. */
  async tick(): Promise<void> {
    const pending = await this.prisma.project.findMany({
      where: { mirrorStatus: 'pending', enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const project of pending) await this.mirrors.clone(project);
  }

  start(intervalMs: number): void {
    const run = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`Worker tick failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void run(), intervalMs);
    void run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
