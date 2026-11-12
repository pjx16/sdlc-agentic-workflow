import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker/worker.module';
import { WorkerRunner } from './worker/worker-runner';

/** Worker entrypoint: takes the advisory lock, then runs the loop. A second worker exits with code 1. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  if (!(await app.get(WorkerRunner).start())) {
    await app.close();
    process.exit(1);
  }
}

void bootstrap();
