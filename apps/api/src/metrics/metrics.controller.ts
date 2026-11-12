import { Controller, Get, Query } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('summary')
  summary(@Query('range') range?: string) {
    return this.metrics.summary(range);
  }

  @Get('usage')
  usage(@Query('range') range?: string) {
    return this.metrics.usage(range);
  }

  @Get('tokens')
  tokens(@Query('range') range?: string, @Query('groupBy') groupBy?: string) {
    return this.metrics.tokens(range, groupBy);
  }

  @Get('merged')
  merged(@Query('range') range?: string) {
    return this.metrics.merged(range);
  }

  @Get('tickets-by-state')
  ticketsByState() {
    return this.metrics.ticketsByState();
  }

  @Get('quality')
  quality(@Query('range') range?: string) {
    return this.metrics.quality(range);
  }

  @Get('durations')
  durations(@Query('range') range?: string) {
    return this.metrics.durations(range);
  }
}
