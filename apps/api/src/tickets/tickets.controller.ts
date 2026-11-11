import { Body, Controller, Post } from '@nestjs/common';
import type { TicketDto } from './ticket.dto';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  paste(@Body() body: unknown): Promise<TicketDto> {
    return this.tickets.paste(body);
  }
}
