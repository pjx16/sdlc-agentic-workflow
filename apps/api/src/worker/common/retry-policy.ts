import { describeError, nextBackoffMin, type ErrorCode } from '@sdlc/shared';

export interface RetryOptions {
  /** Waits between attempts. Tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  /** Shrinks the minutes of the policy table (0 in tests). */
  scale?: number;
  /** Errors that retrying cannot fix: they are thrown at once. */
  isFinal?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; waitMin: number; message: string }) => void;
}

/** An error that is already out of retries; carries its code and the plain-English message of the policy table. */
export class PolicyError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail: string,
    override readonly cause?: unknown,
  ) {
    super(describeError(code, { detail }));
    this.name = 'PolicyError';
  }
}

/**
 * Runs `fn`, retrying a failure with the waits the policy table gives `code` (BUILD_PLAN v1 6.3, 3 times with 1, 4 and
 * 10 minutes for Git and GitHub). When the retries are used up it throws a PolicyError for the caller to hold on.
 */
export async function withRetry<T>(code: ErrorCode, fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const waitMin = opts.isFinal?.(err) ? null : nextBackoffMin(code, attempt);
      if (waitMin === null) throw new PolicyError(code, message, err);
      opts.onRetry?.({ attempt, waitMin, message });
      if (waitMin > 0) await sleep(waitMin * 60_000 * (opts.scale ?? 1));
    }
  }
}
