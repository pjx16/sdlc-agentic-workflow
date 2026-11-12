import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AdvisoryLock } from './loop/advisory-lock';
import { RestartRecovery } from './loop/restart-recovery';
import { WorkerLoop } from './loop/worker-loop';
import { WorkerConfig } from './worker-config';

@Injectable()
export class WorkerRunner implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly lock: AdvisoryLock;

  constructor(
    private readonly config: WorkerConfig,
    private readonly loop: WorkerLoop,
    private readonly recovery: RestartRecovery,
  ) {
    this.lock = new AdvisoryLock(config.databaseUrl);
  }

  /** Takes the single-worker lock and starts the loop. Returns false if another worker already runs. */
  async start(): Promise<boolean> {
    if (!(await this.lock.acquire())) {
      this.logger.error('Another worker already holds the lock; refusing to start');
      return false;
    }
    this.logger.log('Worker lock acquired');
    await this.recovery.recover();
    this.loop.start();
    this.logger.log('Worker loop started');
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    this.loop.stop();
    await this.lock.release();
  }
}
