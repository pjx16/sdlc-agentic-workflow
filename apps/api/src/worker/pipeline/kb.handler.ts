import { Inject, Injectable, Optional } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceService } from '../git/workspace.service';
import { featureKeyOf, lookup } from '../kb/kb-index';
import type { StepHandler, StepOutcome } from './step-handler';

/** Builds a KB doc for a ticket that has none (the `kbBuild` stage). */
export interface KbBuilder {
  run(ticket: Ticket): Promise<StepOutcome>;
}
export const KB_BUILDER = Symbol('KB_BUILDER');

/**
 * KB -> PLANNING (row 2): the ticket's feature key is matched against the KB index. A match is used as it is; with no
 * match `kbBuild` runs, unless it is turned off, in which case the ticket is planned without a KB doc.
 */
@Injectable()
export class KbHandler implements StepHandler {
  readonly status = 'KB' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
    @Optional() @Inject(KB_BUILDER) private readonly builder?: KbBuilder,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const { path: workspace } = await this.workspaces.prepare(ticket.id); // cheap when the workspace already exists

    const wanted = featureKeyOf(ticket);
    const { match, warning } = await lookup(workspace, project.kbDir, wanted);
    if (warning) await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: warning.slice(0, 500) } });

    if (match) {
      if (ticket.featureKey !== match.entry.key) await this.prisma.ticket.update({ where: { id: ticket.id }, data: { featureKey: match.entry.key } });
      return { kind: 'transition', to: 'PLANNING', reason: `KB doc matched: ${match.entry.key}` };
    }
    if (!settings.stages.kbBuild.enabled) return { kind: 'transition', to: 'PLANNING', reason: 'No KB doc, and kbBuild is off' };
    if (!this.builder) return { kind: 'hold', reason: 'needs_help', note: 'No KB doc matched and the kbBuild stage is not available' };
    return this.builder.run(ticket);
  }
}
