import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { TicketDto } from './ticket.dto';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@Query('projectId') projectId?: string, @Query('status') status?: string) {
    return this.tickets.list({ projectId, status });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tickets.get(id);
  }

  @Get(':id/transitions')
  transitions(@Param('id') id: string) {
    return this.tickets.transitions(id);
  }

  @Get(':id/timeline')
  timeline(@Param('id') id: string) {
    return this.tickets.timeline(id);
  }

  @Post()
  paste(@Body() body: unknown): Promise<TicketDto> {
    return this.tickets.paste(body);
  }
}
