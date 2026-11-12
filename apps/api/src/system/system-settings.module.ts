import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({ controllers: [SystemController], providers: [SystemSettingsService], exports: [SystemSettingsService] })
export class SystemSettingsModule {}
