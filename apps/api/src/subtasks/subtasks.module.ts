import { Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { SubtasksService } from './subtasks.service';

@Module({ imports: [JiraModule], providers: [SubtasksService], exports: [SubtasksService] })
export class SubtasksModule {}
