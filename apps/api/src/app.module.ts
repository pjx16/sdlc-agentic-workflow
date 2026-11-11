import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { LoggingModule } from './logging.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { SystemSettingsModule } from './system/system-settings.module';
import { SystemModule } from './system/system.module';

@Module({ imports: [LoggingModule, PrismaModule, AuthModule, ProjectsModule, SystemModule, SystemSettingsModule] })
export class AppModule {}
