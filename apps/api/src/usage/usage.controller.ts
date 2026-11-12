import { Controller, Get, Query } from '@nestjs/common';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('snapshots')
  snapshots(@Query('from') from?: string, @Query('to') to?: string) {
    return this.usage.snapshots({ from, to });
  }

  @Get('summary')
  summary() {
    return this.usage.summary();
  }
}
