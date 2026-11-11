import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { Housekeeper } from '../loop/worker-loop';
import { IntakePoller } from './intake-poller';

/**
 * MCP-mode intake (F3): each project in MCP mode is polled every `intake.mcpPollIntervalSec` (default 900; every poll costs a stage run),
 * and not at all while the pipeline is paused. The intake switch and Jira backoff are the same as in REST mode.
 */
@Injectable()
export class McpIntake implements Housekeeper {
  readonly name = 'mcp-intake';
  /** Checked often; each project has its own, longer interval. */
  readonly intervalMs = 30_000;
  private readonly last = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: IntakePoller,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async check(): Promise<void> {
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (settings?.pipelinePaused) return;
    const t = this.now();
    await this.intake.poll('mcp', (project) => {
      const every = ProjectSettingsSchema.parse(project.settings).intake.mcpPollIntervalSec * 1000;
      const previous = this.last.get(project.id);
      if (previous !== undefined && t - previous < every) return false;
      this.last.set(project.id, t);
      return true;
    });
  }
}
