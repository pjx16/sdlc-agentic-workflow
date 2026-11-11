import { Module } from '@nestjs/common';
import { SubtasksService } from './subtasks.service';

@Module({ providers: [SubtasksService], exports: [SubtasksService] })
export class SubtasksModule {}
