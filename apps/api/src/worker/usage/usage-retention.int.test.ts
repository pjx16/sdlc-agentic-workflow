import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { UsageRetention } from './usage-retention';

describe('UsageRetention', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  const now = new Date('2026-11-14T12:00:00Z');
  const at = (days: number, minutes = 0) => new Date(now.getTime() - days * 86_400_000 + minutes * 60_000);

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });

  it('keeps everything from the last 90 days and one snapshot per hour before that', async () => {
    const snap = (when: Date, pct: number) => prisma.usageSnapshot.create({ data: { at: when, fiveHourPct: pct, source: 'event' } });
    // Recent: three in one hour, all kept.
    await snap(at(1), 1);
    await snap(at(1, 10), 2);
    await snap(at(1, 20), 3);
    // Old: three in one hour (the last one stays), and one in the next hour.
    const old = at(100);
    old.setUTCMinutes(0, 0, 0);
    await snap(new Date(old.getTime() + 5 * 60_000), 10);
    await snap(new Date(old.getTime() + 25 * 60_000), 11);
    await snap(new Date(old.getTime() + 45 * 60_000), 12);
    await snap(new Date(old.getTime() + 65 * 60_000), 13);

    const removed = await new UsageRetention(prisma, () => now).run();

    expect(removed).toBe(2);
    const left = (await prisma.usageSnapshot.findMany({ orderBy: { at: 'asc' } })).map((r) => r.fiveHourPct);
    expect(left).toEqual([12, 13, 1, 2, 3]);
  });

  it('is a no-op when run again', async () => {
    expect(await new UsageRetention(prisma, () => now).run()).toBe(0);
  });
});
