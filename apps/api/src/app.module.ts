import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { GuidelinesModule } from './guidelines/guidelines.module';
import { LoggingModule } from './logging.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { RunsModule } from './runs/runs.module';
import { StateModule } from './state/state.module';
import { SupportModule } from './support/support.module';
import { MetricsModule } from './metrics/metrics.module';
import { UsageModule } from './usage/usage.module';
import { TicketsModule } from './tickets/tickets.module';
import { SystemSettingsModule } from './system/system-settings.module';
import { SystemModule } from './system/system.module';

@Module({ imports: [LoggingModule, PrismaModule, StateModule, AuthModule, GuidelinesModule, ProjectsModule, RunsModule, TicketsModule, SupportModule, UsageModule, MetricsModule, SystemModule, SystemSettingsModule] })
export class AppModule {}
