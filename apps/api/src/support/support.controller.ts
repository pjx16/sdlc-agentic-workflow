import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { SupportService } from './support.service';

@Controller('support-queries')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.support.list({ status });
  }

  @Post(':id/answer')
  @HttpCode(HttpStatus.OK)
  answer(@Param('id') id: string, @Body() body: unknown) {
    return this.support.answer(id, body);
  }
}
