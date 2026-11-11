/** Where a stage's output lines go. The file implementation with redaction is added in 3.6. */
export interface StageLog {
  write(line: string): void;
  /** Flushes and closes; resolves with the log path (or undefined for sinks that keep no file). */
  close(): Promise<string | undefined>;
}

export interface LogSink {
  open(stageRunId: string): StageLog;
}

export const LOG_SINK = Symbol('LOG_SINK');

export class NullLogSink implements LogSink {
  open(): StageLog {
    return { write: () => undefined, close: async () => undefined };
  }
}
