import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** Matches WORKER_ONLINE_MS: the heartbeat timer writes every 5 seconds, so 30 seconds of silence means the process is hung or gone. */
export const MAX_HEARTBEAT_AGE_MS = 30_000;

export function heartbeatFresh(heartbeatAt: Date | null | undefined, now: number = Date.now()): boolean {
  return !!heartbeatAt && now - heartbeatAt.getTime() < MAX_HEARTBEAT_AGE_MS;
}

/** Docker healthcheck for the worker service: exits 1 when the worker's heartbeat is older than 30 seconds. */
async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const row = await prisma.workerStatus.findUnique({ where: { id: 'worker' } });
    if (!heartbeatFresh(row?.heartbeatAt)) {
      console.error('Worker heartbeat is missing or older than 30 seconds');
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
