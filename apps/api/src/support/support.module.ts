import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { AssistantService } from './assistant.service';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({ imports: [TicketsModule], controllers: [SupportController], providers: [SupportService, AssistantService] })
export class SupportModule {}
