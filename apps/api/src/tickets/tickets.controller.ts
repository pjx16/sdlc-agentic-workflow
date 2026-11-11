import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
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

  @Post(':id/plan/approve')
  @HttpCode(HttpStatus.OK)
  approvePlan(@Param('id') id: string, @Body() body: unknown) {
    return this.tickets.approvePlan(id, body);
  }

  @Post(':id/plan/reject')
  @HttpCode(HttpStatus.OK)
  rejectPlan(@Param('id') id: string, @Body() body: unknown) {
    return this.tickets.rejectPlan(id, body);
  }

  @Post(':id/breakdown/approve')
  @HttpCode(HttpStatus.OK)
  approveBreakdown(@Param('id') id: string, @Body() body: unknown) {
    return this.tickets.approveBreakdown(id, body);
  }

  @Post(':id/breakdown/reject')
  @HttpCode(HttpStatus.OK)
  rejectBreakdown(@Param('id') id: string, @Body() body: unknown) {
    return this.tickets.rejectBreakdown(id, body);
  }

  @Post(':id/hold')
  @HttpCode(HttpStatus.OK)
  hold(@Param('id') id: string) {
    return this.tickets.holdTicket(id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@Param('id') id: string) {
    return this.tickets.resumeTicket(id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id') id: string) {
    return this.tickets.retryTicket(id);
  }

  @Post(':id/kb-update/rerun')
  @HttpCode(HttpStatus.OK)
  rerunKbUpdate(@Param('id') id: string) {
    return this.tickets.rerunKbUpdate(id);
  }

  @Post()
  paste(@Body() body: unknown): Promise<TicketDto> {
    return this.tickets.paste(body);
  }
}
