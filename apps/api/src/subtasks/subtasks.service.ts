import { Injectable } from '@nestjs/common';
import type { SubtaskDraft } from '@sdlc/shared';
import type { Prisma, Subtask } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Creates the ordered Subtask rows of an approved breakdown (F8). */
@Injectable()
export class SubtasksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replaces the ticket's subtasks with the given (already validated) list, ordered by `seq`, all PENDING.
   * Replacing makes this safe to repeat, for example after a retry.
   */
  async create(ticketId: string, drafts: readonly SubtaskDraft[]): Promise<Subtask[]> {
    const ordered = [...drafts].sort((a, b) => a.seq - b.seq);
    return this.prisma.$transaction(async (tx) => {
      await tx.subtask.deleteMany({ where: { ticketId } });
      const rows: Subtask[] = [];
      for (const d of ordered) {
        rows.push(
          await tx.subtask.create({
            data: {
              ticketId,
              seq: d.seq,
              title: d.title,
              description: d.description,
              acceptanceCriteria: d.acceptanceCriteria as Prisma.InputJsonValue,
              files: d.files as Prisma.InputJsonValue,
              dependsOn: d.dependsOn as Prisma.InputJsonValue,
              status: 'PENDING',
            },
          }),
        );
      }
      await tx.event.create({ data: { ticketId, type: 'state', message: `Created ${rows.length} subtask(s)` } });
      return rows;
    });
  }
}
