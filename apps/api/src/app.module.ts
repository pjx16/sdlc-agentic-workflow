import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: { ignore: (req) => req.url === '/health' },
        redact: ['req.headers.cookie', 'req.headers.authorization'],
      },
    }),
    SystemModule,
  ],
})
export class AppModule {}
