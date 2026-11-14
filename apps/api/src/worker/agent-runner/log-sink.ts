/** Where a stage's output lines go. `FileLogSink` writes the redacted file. */
export interface StageLog {
  write(line: string): void;
  /** Flushes and closes; resolves with the log path (or undefined for sinks that keep no file). */
  close(): Promise<string | undefined>;
}

export interface LogSink {
  /** `extraSecrets` are per-run credentials to redact as well. */
  open(stageRunId: string, extraSecrets?: readonly string[]): StageLog;
}

export const LOG_SINK = Symbol('LOG_SINK');

export class NullLogSink implements LogSink {
  open(): StageLog {
    return { write: () => undefined, close: async () => undefined };
  }
}
