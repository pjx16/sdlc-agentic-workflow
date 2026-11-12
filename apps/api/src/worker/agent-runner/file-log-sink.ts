import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { createRedactor } from '../../common/redact';
import { WorkerConfig } from '../worker-config';
import type { LogSink, StageLog } from './log-sink';

/** Writes `DATA_DIR/logs/<stageRunId>.log`, redacting known secrets before anything reaches the disk (F5). */
@Injectable()
export class FileLogSink implements LogSink {
  constructor(private readonly config: WorkerConfig) {}

  open(stageRunId: string, extraSecrets: readonly string[] = []): StageLog {
    const file = this.config.logPath(stageRunId);
    mkdirSync(path.dirname(file), { recursive: true });
    const stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    const redact = createRedactor([this.config.claudeToken, this.config.githubToken, ...this.config.extraSecrets, ...extraSecrets]);
    return {
      write: (line) => void stream.write(`${redact(line)}\n`),
      close: () => new Promise((resolve) => stream.end(() => resolve(file))),
    };
  }
}
