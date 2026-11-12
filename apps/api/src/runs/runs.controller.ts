import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunsService } from './runs.service';
import { streamLog } from './run-log-streamer';

const KEEPALIVE_MS = 15_000;

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post(':id/kill')
  @HttpCode(HttpStatus.OK)
  kill(@Param('id') id: string) {
    return this.runs.kill(id);
  }

  /** Server-sent events: one `data:` line per log line, then an `end` event when the run finishes. */
  @Get(':id/log')
  async log(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.runs.logFile(id); // 404 before any SSE headers are sent
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    try {
      await streamLog({
        file,
        getStatus: () => this.runs.status(id),
        onLine: (line) => res.write(`data: ${line}\n\n`),
        onEnd: (status) => res.write(`event: end\ndata: ${status}\n\n`),
        signal: abort.signal,
      });
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  }
}
