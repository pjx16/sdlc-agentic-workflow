import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { TicketDto } from './ticket.dto';
import { RerunService } from './rerun.service';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly reruns: RerunService,
  ) {}

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

  @Get(':id/moves')
  moves(@Param('id') id: string) {
    return this.tickets.moves(id);
  }

  @Get(':id/artifacts')
  artifacts(@Param('id') id: string) {
    return this.tickets.artifacts(id);
  }

  @Get(':id/decisions')
  decisions(@Param('id') id: string) {
    return this.tickets.decisions(id);
  }

  @Get(':id/events')
  events(@Param('id') id: string) {
    return this.tickets.events(id);
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

  @Get(':id/hold')
  holdInfo(@Param('id') id: string) {
    return this.tickets.holdInfo(id);
  }

  /** Sends the ticket back to a stage that already finished (BUILD_PLAN v1 6.8). */
  @Post(':id/rerun')
  @HttpCode(HttpStatus.OK)
  rerun(@Param('id') id: string, @Body() body: unknown) {
    return this.reruns.rerun(id, body);
  }

  /** One subtask's tests or implementation again. Replaces `redo-tests`. */
  @Post(':id/subtasks/:seq/rerun')
  @HttpCode(HttpStatus.OK)
  rerunSubtask(@Param('id') id: string, @Param('seq') seq: string, @Body() body: unknown) {
    return this.reruns.rerunSubtask(id, Number(seq), body);
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
