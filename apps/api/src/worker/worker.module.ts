import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging.module';
import { PrismaModule } from '../prisma/prisma.module';

/** The worker shares the database but has no HTTP surface and needs no dashboard credentials. */
@Module({ imports: [LoggingModule, PrismaModule] })
export class WorkerModule {}
