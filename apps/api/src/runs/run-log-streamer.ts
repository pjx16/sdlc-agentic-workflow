import { open } from 'node:fs/promises';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'needs_input', 'killed']);

export interface StreamLogOptions {
  file: string;
  /** Current status of the run, or null if it no longer exists. */
  getStatus: () => Promise<string | null>;
  onLine: (line: string) => void;
  /** Called once when the run is finished and the whole log has been sent. */
  onEnd: (status: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

async function readFrom(file: string, offset: number): Promise<Buffer | null> {
  // Open first and size the open handle: checking the file and opening it separately could race with the file being replaced.
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null; // no file yet
  try {
    const size = (await handle.stat()).size;
    if (size <= offset) return null; // nothing new
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Sends a run's log line by line: what is already on disk first, then new lines as they appear,
 * and `onEnd` once the run has finished and everything has been sent (F5, BUILD_PLAN 8 Runs).
 */
export async function streamLog(opts: StreamLogOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 500;
  let offset = 0;
  let partial = '';
  const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, pollMs));

  while (!opts.signal?.aborted) {
    // Read the status BEFORE the file: if the run was already finished, nothing more can be written after this read.
    const status = await opts.getStatus();
    const chunk = await readFrom(opts.file, offset);
    if (chunk) {
      offset += chunk.length;
      partial += chunk.toString('utf8');
      let index: number;
      while ((index = partial.indexOf('\n')) >= 0) {
        opts.onLine(partial.slice(0, index));
        partial = partial.slice(index + 1);
      }
    }
    const finished = status === null || TERMINAL_STATUSES.has(status);
    if (finished && !chunk) {
      if (partial) opts.onLine(partial);
      opts.onEnd(status ?? 'missing');
      return;
    }
    if (!chunk) await sleep();
  }
}
