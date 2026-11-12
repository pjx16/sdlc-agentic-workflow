import { Injectable } from '@nestjs/common';
import type { Ticket } from '../../generated/prisma/client';
import { WorkspaceService } from '../git/workspace.service';
import type { StepHandler, StepOutcome } from './step-handler';

/** NEW -> KB (row 1): the worker picks the ticket up, prepares its workspace on the ticket branch, and installs dependencies. */
@Injectable()
export class NewTicketHandler implements StepHandler {
  readonly status = 'NEW' as const;

  constructor(private readonly workspaces: WorkspaceService) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const ws = await this.workspaces.prepare(ticket.id);
    if (ws.install && !ws.install.ok) {
      const tail = ws.install.tail.split('\n').slice(-5).join('\n');
      return { kind: 'hold', reason: 'needs_help', note: `${ws.install.timedOut ? 'The dependency install timed out' : 'The dependency install failed'}:\n${tail}`.slice(0, 500) };
    }
    return { kind: 'transition', to: 'KB', reason: `Workspace ready on ${ws.branch}` };
  }
}
