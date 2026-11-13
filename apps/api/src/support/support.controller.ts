import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AssistantService } from './assistant.service';
import { SupportService } from './support.service';

@Controller('support-tickets')
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly assistant: AssistantService,
  ) {}

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

  @Get(':id/assistant')
  conversation(@Param('id') id: string) {
    return this.assistant.get(id);
  }

  @Post(':id/assistant/messages')
  @HttpCode(HttpStatus.OK)
  send(@Param('id') id: string, @Body() body: unknown) {
    return this.assistant.send(id, body);
  }

  @Post(':id/assistant/messages/:messageId/apply')
  @HttpCode(HttpStatus.OK)
  apply(@Param('id') id: string, @Param('messageId') messageId: string) {
    return this.assistant.apply(id, messageId);
  }

  @Post(':id/action')
  @HttpCode(HttpStatus.OK)
  act(@Param('id') id: string, @Body() body: unknown) {
    return this.support.act(id, body);
  }
}
