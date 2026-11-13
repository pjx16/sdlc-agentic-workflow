import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Housekeeper } from '../loop/worker-loop';

const DAY_MS = 86_400_000;
/** Snapshots newer than this keep full detail (BUILD_PLAN v1 6.2). */
export const FULL_DETAIL_DAYS = 90;

/** Once a day: snapshots older than 90 days are reduced to the last one of each hour. Nothing newer is touched. */
@Injectable()
export class UsageRetention implements Housekeeper {
  readonly name = 'usage-retention';
  readonly intervalMs = DAY_MS;
  private readonly logger = new Logger(UsageRetention.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<void> {
    const removed = await this.run();
    if (removed > 0) this.logger.log(`Usage retention reduced old snapshots to one per hour (${removed} removed)`);
  }

  /** Returns how many rows were deleted. */
  async run(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - FULL_DETAIL_DAYS * DAY_MS);
    return this.prisma.$executeRaw`
      DELETE FROM "UsageSnapshot"
      WHERE "at" < ${cutoff}
        AND "id" NOT IN (
          SELECT DISTINCT ON (date_trunc('hour', "at" AT TIME ZONE 'UTC')) "id"
          FROM "UsageSnapshot"
          WHERE "at" < ${cutoff}
          ORDER BY date_trunc('hour', "at" AT TIME ZONE 'UTC'), "at" DESC
        )`;
  }
}
