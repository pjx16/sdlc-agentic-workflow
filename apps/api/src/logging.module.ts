import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

/** The session token travels in Cookie and Set-Cookie headers, so neither may reach the logs (S4). */
export const LOG_REDACT_PATHS = ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'];

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: { ignore: (req) => req.url === '/health' },
        redact: LOG_REDACT_PATHS,
      },
    }),
  ],
})
export class LoggingModule {}
