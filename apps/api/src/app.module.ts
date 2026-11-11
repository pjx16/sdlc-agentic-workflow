import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { LoggingModule } from './logging.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { RunsModule } from './runs/runs.module';
import { StateModule } from './state/state.module';
import { TicketsModule } from './tickets/tickets.module';
import { SystemSettingsModule } from './system/system-settings.module';
import { SystemModule } from './system/system.module';

@Module({ imports: [LoggingModule, PrismaModule, StateModule, AuthModule, ProjectsModule, RunsModule, TicketsModule, SystemModule, SystemSettingsModule] })
export class AppModule {}
