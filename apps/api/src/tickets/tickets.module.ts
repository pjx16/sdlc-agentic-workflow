import { Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { SubtasksModule } from '../subtasks/subtasks.module';
import { RerunService } from './rerun.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({ imports: [JiraModule, SubtasksModule], controllers: [TicketsController], providers: [TicketsService, RerunService], exports: [TicketsService] })
export class TicketsModule {}
