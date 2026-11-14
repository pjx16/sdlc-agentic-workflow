import { Controller, Get } from '@nestjs/common';
import { OperationsService } from './operations.service';

@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  overview() {
    return this.operations.overview();
  }
}
