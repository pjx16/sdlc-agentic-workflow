import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildCreateOptions, type ContainerSpec } from './container-options';
import { CONTAINER_ENGINE, type ContainerEngine, type OutputStream } from './container-engine';

export const KILL_POLL_MS = 2000;

export interface RunHooks {
  /** Called for every output line (stdout and stderr). */
  onLine?: (line: string, stream: OutputStream) => void;
  /** Polled every `killPollMs`; returning true kills the container (StageRun.killRequested). */
  shouldKill?: () => Promise<boolean>;
  killPollMs?: number;
  /** Called with the container id as soon as it exists. */
  onStarted?: (containerId: string) => void | Promise<void>;
}

export interface ContainerResult {
  containerId: string;
  exitCode: number;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

/** Creates, runs, watches and always removes one container (BUILD_PLAN 6.4). */
@Injectable()
export class ContainerRunner {
  private readonly logger = new Logger(ContainerRunner.name);

  constructor(@Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine) {}

  async run(spec: ContainerSpec, hooks: RunHooks = {}): Promise<ContainerResult> {
    const container = await this.engine.create(buildCreateOptions(spec));
    const startedAt = Date.now();
    let timedOut = false;
    let killed = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    try {
      await container.attach((line, stream) => hooks.onLine?.(line, stream));
      await container.start();
      await hooks.onStarted?.(container.id);

      const stop = (reason: 'timeout' | 'kill') => {
        if (reason === 'timeout') timedOut = true;
        else killed = true;
        container.kill().catch((err: unknown) => this.logger.warn(`kill failed for ${container.id}: ${String(err)}`));
      };
      timeoutTimer = setTimeout(() => stop('timeout'), spec.timeoutMs);
      if (hooks.shouldKill) {
        const shouldKill = hooks.shouldKill;
        let polling = false;
        pollTimer = setInterval(() => {
          if (polling || timedOut || killed) return;
          polling = true;
          shouldKill()
            .then((yes) => yes && stop('kill'))
            .catch(() => undefined) // a failed poll must not stop the run; the next poll retries
            .finally(() => {
              polling = false;
            });
        }, hooks.killPollMs ?? KILL_POLL_MS);
      }

      const exitCode = await container.wait();
      return { containerId: container.id, exitCode, timedOut, killed, durationMs: Date.now() - startedAt };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      await container.remove().catch((err: unknown) => this.logger.warn(`remove failed for ${container.id}: ${String(err)}`));
    }
  }
}
