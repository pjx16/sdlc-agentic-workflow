import { Module } from '@nestjs/common';
import { GuidelinesController } from './guidelines.controller';
import { GuidelinesService } from './guidelines.service';

@Module({ controllers: [GuidelinesController], providers: [GuidelinesService] })
export class GuidelinesModule {}
