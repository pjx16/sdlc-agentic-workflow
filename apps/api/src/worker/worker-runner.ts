import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CONTAINER_ENGINE, type ContainerEngine } from './agent-runner/container-engine';
import { AdvisoryLock } from './loop/advisory-lock';
import { RestartRecovery } from './loop/restart-recovery';
import { WorkerLoop } from './loop/worker-loop';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatTimer, recordStart } from './status/worker-status';
import { WorkerConfig } from './worker-config';

@Injectable()
export class WorkerRunner implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly lock: AdvisoryLock;
  private readonly heartbeat: HeartbeatTimer;

  constructor(
    private readonly config: WorkerConfig,
    private readonly loop: WorkerLoop,
    private readonly recovery: RestartRecovery,
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
    private readonly prisma: PrismaService,
  ) {
    this.lock = new AdvisoryLock(config.databaseUrl);
    this.heartbeat = new HeartbeatTimer(prisma);
  }

  /** Takes the single-worker lock and starts the loop. Returns false if another worker already runs. */
  async start(): Promise<boolean> {
    if (!(await this.lock.acquire())) {
      this.logger.error('Another worker already holds the lock; refusing to start');
      return false;
    }
    this.logger.log('Worker lock acquired');
    await recordStart(this.prisma, process.env.npm_package_version ?? '0.0.1');
    await this.heartbeat.start();
    await this.ensureAgentImage();
    await this.recovery.recover();
    this.loop.start();
    this.logger.log('Worker loop started');
    return true;
  }

  /** Pulls the agent image on first start. A failure is logged and the worker keeps running; the stage error path reports it. */
  private async ensureAgentImage(): Promise<void> {
    try {
      const result = await this.engine.ensureImage(this.config.agentImage);
      if (result === 'present') this.logger.log(`Agent image ${this.config.agentImage} is available`);
    } catch (err) {
      this.logger.error(`Could not make the agent image ${this.config.agentImage} available: ${err instanceof Error ? err.message : String(err)}. Stages will fail until it is.`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.loop.stop();
    this.heartbeat.stop();
    await this.lock.release();
  }
}
