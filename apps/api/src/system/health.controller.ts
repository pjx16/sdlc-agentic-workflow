import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health(): { ok: true } {
    return { ok: true };
  }
}
