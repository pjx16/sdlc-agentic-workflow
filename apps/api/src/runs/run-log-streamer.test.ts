import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamLog } from './run-log-streamer';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-stream-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const collect = (file: string, getStatus: () => Promise<string | null>, signal?: AbortSignal) => {
  const lines: string[] = [];
  let end: string | undefined;
  const done = streamLog({ file, getStatus, onLine: (l) => lines.push(l), onEnd: (s) => void (end = s), pollMs: 10, signal });
  return { lines, done, end: () => end };
};

describe('streamLog', () => {
  it('sends what is on disk and then ends when the run is already finished', async () => {
    const file = path.join(tmp, 'a.log');
    writeFileSync(file, 'one\ntwo\n');
    const s = collect(file, async () => 'succeeded');
    await s.done;
    expect(s.lines).toEqual(['one', 'two']);
    expect(s.end()).toBe('succeeded');
  });

  it('streams lines appended while the run is running, then ends', async () => {
    const file = path.join(tmp, 'b.log');
    writeFileSync(file, 'first\n');
    let status = 'running';
    const s = collect(file, async () => status);
    await new Promise((r) => setTimeout(r, 40));
    expect(s.lines).toEqual(['first']);
    expect(s.end()).toBeUndefined();
    appendFileSync(file, 'second\nthird\n');
    await new Promise((r) => setTimeout(r, 40));
    expect(s.lines).toEqual(['first', 'second', 'third']);
    status = 'failed';
    await s.done;
    expect(s.end()).toBe('failed');
  });

  it('joins a line that arrives in two pieces and flushes an unterminated last line', async () => {
    const file = path.join(tmp, 'c.log');
    writeFileSync(file, 'par');
    let status = 'running';
    const s = collect(file, async () => status);
    await new Promise((r) => setTimeout(r, 30));
    appendFileSync(file, 'tial\nlast-no-newline');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.lines).toEqual(['partial']);
    status = 'killed';
    await s.done;
    expect(s.lines).toEqual(['partial', 'last-no-newline']);
  });

  it('waits for a log file that does not exist yet', async () => {
    const file = path.join(tmp, 'd.log');
    let status = 'queued';
    const s = collect(file, async () => status);
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(file, 'hello\n');
    status = 'succeeded';
    await s.done;
    expect(s.lines).toEqual(['hello']);
  });

  it('ends immediately with an empty log for a finished run that wrote nothing, and when the run is gone', async () => {
    const none = collect(path.join(tmp, 'never.log'), async () => 'failed');
    await none.done;
    expect(none.lines).toEqual([]);
    expect(none.end()).toBe('failed');
    const gone = collect(path.join(tmp, 'never.log'), async () => null);
    await gone.done;
    expect(gone.end()).toBe('missing');
  });

  it('stops when the client disconnects', async () => {
    const file = path.join(tmp, 'e.log');
    writeFileSync(file, 'x\n');
    const abort = new AbortController();
    const s = collect(file, async () => 'running', abort.signal);
    await new Promise((r) => setTimeout(r, 30));
    abort.abort();
    await s.done;
    expect(s.end()).toBeUndefined();
  });
});
