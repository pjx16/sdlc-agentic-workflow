import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({ imports: [TicketsModule], controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
