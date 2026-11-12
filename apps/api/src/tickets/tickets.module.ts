import { Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({ imports: [JiraModule], controllers: [TicketsController], providers: [TicketsService], exports: [TicketsService] })
export class TicketsModule {}
