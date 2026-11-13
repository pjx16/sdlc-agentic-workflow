import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { SupportService } from './support.service';

@Controller('support-tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query('tab') tab?: string, @Query('kind') kind?: string, @Query('ticketId') ticketId?: string) {
    return this.support.list({ tab, kind, ticketId });
  }

  @Get('counts')
  counts() {
    return this.support.counts();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.support.get(id);
  }

  @Post(':id/action')
  @HttpCode(HttpStatus.OK)
  act(@Param('id') id: string, @Body() body: unknown) {
    return this.support.act(id, body);
  }
}
