import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { LoggingModule } from './logging.module';
import { PrismaModule } from './prisma/prisma.module';
import { SystemModule } from './system/system.module';

@Module({ imports: [LoggingModule, PrismaModule, AuthModule, SystemModule] })
export class AppModule {}
