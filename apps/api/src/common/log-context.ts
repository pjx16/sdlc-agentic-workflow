export interface LogContext {
  ticket?: string | null;
  stage?: string | null;
  run?: string | null;
  subtask?: number | string | null;
}

/**
 * One readable line with the context that is known (BUILD_PLAN v1 6.4):
 * `[ticket=SDA-12 stage=implement run=3fa9c2d1 subtask=2] message`. Missing parts are left out, and a run id is
 * shortened to its first 8 characters, which is enough to find the raw log on disk.
 */
export function logLine(ctx: LogContext, message: string): string {
  const parts: string[] = [];
  if (ctx.ticket) parts.push(`ticket=${ctx.ticket}`);
  if (ctx.stage) parts.push(`stage=${ctx.stage}`);
  if (ctx.run) parts.push(`run=${ctx.run.slice(0, 8)}`);
  if (ctx.subtask !== undefined && ctx.subtask !== null && ctx.subtask !== '') parts.push(`subtask=${ctx.subtask}`);
  return parts.length > 0 ? `[${parts.join(' ')}] ${message}` : message;
}
