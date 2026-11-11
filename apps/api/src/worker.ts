import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker/worker.module';

/** Worker entrypoint. Idle placeholder until milestone 4 adds the worker loop. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('worker started (idle placeholder)');
  // Keep the process alive until a shutdown signal closes the context.
  setInterval(() => undefined, 60_000);
}

void bootstrap();
