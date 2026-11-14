import { Injectable, Logger } from '@nestjs/common';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PushRejectedError } from '../git/commit';
import { WorkspaceService } from '../git/workspace.service';
import type { StepOutcome } from './step-handler';

/**
 * What the worker does before a stage runs again after a rerun (BUILD_PLAN v1 6.8, steps 3 and 4): remove the stale code with one
 * revert commit and push it normally. The API cannot touch the workspace, so the rerun only recorded where the stale work starts
 * (`Ticket.revertFromSha`); this does the rest.
 *
 * It never rewrites history and never reverts a commit it did not make: if a person pushed to the branch, the ticket is held with
 * their commits named, and the revert is tried again when it is resumed.
 */
@Injectable()
export class RerunPrep {
  private readonly logger = new Logger(RerunPrep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
  ) {}

  /** Returns null when the stage may run, or the outcome (a hold) when it may not. */
  async prepare(ticket: Ticket): Promise<StepOutcome | null> {
    if (!ticket.revertFromSha) return null;
    const stage = ticket.revertStage ?? 'an earlier stage';
    let result;
    try {
      result = await this.workspaces.revertRange(ticket.id, `${ticket.revertFromSha}..HEAD`, `revert: drop work superseded by rerun of ${stage} (${ticket.key})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Reverting the stale work of ${ticket.key} failed: ${message}`);
      return { kind: 'hold', reason: 'needs_help', note: `Git failed while removing the stale work of the rerun: ${message}`.slice(0, 500) };
    }

    if (result.status === 'human') {
      return { kind: 'hold', reason: 'needs_help', note: `Branch has commits not made by sdlc-agent: ${result.shas.join(', ')}. The stale work was left in place. Resume once they are dealt with.` };
    }
    if (result.status === 'conflict') {
      return { kind: 'hold', reason: 'needs_help', note: `Git failed: removing the stale work conflicts with later changes in ${result.files.join(', ') || 'some files'}.` };
    }
    if (result.status === 'reverted') {
      try {
        await this.workspaces.push(ticket.id);
      } catch (err) {
        if (err instanceof PushRejectedError) return { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500) };
        throw err;
      }
    }
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { revertFromSha: null, revertStage: null } });
    return null;
  }
}
