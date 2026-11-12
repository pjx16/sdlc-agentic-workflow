import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** Forgot password: deletes the admin account and every session. The next API start logs a new setup code. */
async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const admin = await prisma.adminAccount.deleteMany();
    const sessions = await prisma.session.deleteMany();
    console.log(`Removed ${admin.count} admin account(s) and ${sessions.count} session(s). Restart the API to get a new setup code.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
