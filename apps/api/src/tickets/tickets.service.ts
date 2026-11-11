import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes, PasteTicketSchema, ProjectSettingsSchema } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { PrismaService } from '../prisma/prisma.service';
import { type TicketDto, toTicketDto } from './ticket.dto';

const fieldError = (field: string, message: string) => new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { [field]: message });

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  /** POST /tickets: a pasted ticket with a local key `<localKeyPrefix>-<n>`, status NEW. Works in every Jira mode. */
  async paste(body: unknown): Promise<TicketDto> {
    const input = parseBody(PasteTicketSchema, body);
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw fieldError('projectId', 'unknown project');
    if (!project.enabled) throw fieldError('projectId', 'this project is disabled');
    if (!ProjectSettingsSchema.parse(project.settings).intake.paste) throw fieldError('projectId', 'pasting tickets is turned off for this project');
    // F2: a project accepts tickets only when its mirror is ready.
    if (project.mirrorStatus !== 'ok') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `The repository mirror is ${project.mirrorStatus === 'pending' ? 'still being cloned' : 'not ready (it failed)'}`);
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      // Atomic allocation: the increment returns the new counter, so concurrent pastes never share a number.
      const updated = await tx.project.update({ where: { id: project.id }, data: { nextLocalNumber: { increment: 1 } }, select: { nextLocalNumber: true, localKeyPrefix: true } });
      const key = `${updated.localKeyPrefix}-${updated.nextLocalNumber - 1}`;
      const created = await tx.ticket.create({
        data: { projectId: project.id, key, source: 'paste', type: input.type, title: input.title, body: input.body, featureKey: input.featureKey ?? null, status: 'NEW' },
      });
      await tx.event.create({ data: { ticketId: created.id, type: 'intake', message: `${key} pasted` } });
      return created;
    });
    return toTicketDto(ticket);
  }
}
