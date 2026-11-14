import { readFile } from 'node:fs/promises';
import { planDiff, type SupportKind } from '@sdlc/shared';
import type { SupportTicket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The context an assistant conversation gets (BUILD_PLAN v1 6.6): a fixed set of parts per kind of support ticket, built by
 * code, never the whole repository. Each part has a heading, so a test can check that a pack holds only what is listed.
 */
export interface PackSection {
  heading: string;
  body: string;
}
export interface ContextPack {
  sections: PackSection[];
  /** The sections as markdown, for the prompt. */
  text: string;
}

export interface PackDeps {
  /** The last `n` lines of a log file, or '' when it cannot be read. */
  logTail(file: string, n: number): Promise<string>;
  /** The feature doc of the ticket, or null. */
  featureDoc(ticket: { projectId: string; key: string; featureKey: string | null; labels: unknown }): Promise<string | null>;
  /** The plan before the latest rewrite, when there is one (set by the rerun engine in a later phase). */
  previousPlan?(ticketId: string): Promise<string | null>;
}

export const LOG_TAIL_LINES = 60;
const MAX_PLAN_CHARS = 8000;

export const defaultLogTail: PackDeps['logTail'] = async (file, n) => {
  try {
    return (await readFile(file, 'utf8')).split('\n').slice(-n).join('\n').trim();
  } catch {
    return '';
  }
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n… (cut)` : s);

export { planDiff };

export async function buildContextPack(prisma: PrismaService, st: SupportTicket, deps: PackDeps): Promise<ContextPack> {
  const sections: PackSection[] = [];
  const add = (heading: string, body: string | null | undefined) => {
    if (body && body.trim()) sections.push({ heading, body: body.trim() });
  };
  const kind = st.kind as SupportKind;
  const ticket = st.ticketId ? await prisma.ticket.findUnique({ where: { id: st.ticketId }, include: { subtasks: { orderBy: { seq: 'asc' } } } }) : null;
  const summary = () => {
    if (!ticket) return null;
    const first = (ticket.body.split(/\n\s*\n/)[0] ?? '').trim();
    return `${ticket.key}: ${ticket.title}${first ? `\n\n${first.length > 400 ? `${first.slice(0, 397)}...` : first}` : ''}`;
  };

  if (kind === 'approval' && st.stage === 'plan') {
    add('Ticket summary', summary());
    add('Current plan', ticket?.planMarkdown ? clip(ticket.planMarkdown, MAX_PLAN_CHARS) : null);
    const previous = ticket && deps.previousPlan ? await deps.previousPlan(ticket.id) : null;
    if (previous && ticket?.planMarkdown) add('Plan diff', planDiff(previous, ticket.planMarkdown));
    add('Feature doc', ticket ? clip((await deps.featureDoc(ticket)) ?? '', 6000) : null);
    const open = ticket ? await prisma.supportTicket.findMany({ where: { ticketId: ticket.id, kind: 'open_question', status: { in: ['open', 'answered'] } }, orderBy: { createdAt: 'asc' } }) : [];
    add('Open questions', open.map((q) => `- ${q.title}${q.response ? ` (answered: ${q.response})` : q.defaultAnswer ? ` (the plan assumed: ${q.defaultAnswer})` : ''}`).join('\n'));
  } else if (kind === 'approval') {
    add('Ticket summary', summary());
    const subtasks = ticket?.subtasks ?? [];
    const criteria = subtasks.flatMap((s) => (Array.isArray(s.acceptanceCriteria) ? (s.acceptanceCriteria as string[]) : []));
    add('Acceptance criteria', criteria.map((c) => `- ${c}`).join('\n'));
    add('Subtasks', subtasks.map((s) => `${s.seq}. ${s.title}${s.description ? `: ${s.description}` : ''}`).join('\n'));
  } else if (kind === 'question' || kind === 'open_question') {
    add('Question', st.body);
    const run = st.stageRunId ? await prisma.stageRun.findUnique({ where: { id: st.stageRunId } }) : null;
    const said = run?.resultJson && typeof run.resultJson === 'object' ? (run.resultJson as { summary?: unknown }).summary : null;
    add('Asking stage', `${st.stage}${typeof said === 'string' && said ? `: ${said}` : ''}`);
    add('Plan section', ticket?.planMarkdown ? clip(ticket.planMarkdown, MAX_PLAN_CHARS) : null);
    add('Feature doc', ticket ? clip((await deps.featureDoc(ticket)) ?? '', 6000) : null);
  } else if (kind === 'hold' || kind === 'ci_infra') {
    const run = st.stageRunId
      ? await prisma.stageRun.findUnique({ where: { id: st.stageRunId } })
      : st.ticketId
        ? await prisma.stageRun.findFirst({ where: { ticketId: st.ticketId, status: 'failed' }, orderBy: { startedAt: 'desc' } })
        : null;
    add('Why it needs you', st.body);
    add('Error', run ? `${run.errorCode ?? 'UNCLASSIFIED'}${run.error ? `: ${run.error}` : ''}` : null);
    const log = run?.logPath ? await deps.logTail(run.logPath, LOG_TAIL_LINES) : '';
    add(`Last ${LOG_TAIL_LINES} lines of the log`, log ? `\`\`\`\n${log}\n\`\`\`` : null);
    const subtask = run?.subtaskId ? ticket?.subtasks.find((s) => s.id === run.subtaskId) : undefined;
    add('Stage inputs', run ? `stage ${run.stage}, attempt ${run.attempt}${run.round ? `, fix round ${run.round}` : ''}${subtask ? `, subtask ${subtask.seq}: ${subtask.title}` : ''}${ticket ? `, ticket ${summary()?.split('\n')[0]}` : ''}` : null);
  } else {
    add('Ticket', `${st.title}\n\n${st.body}`);
  }

  const text = sections.map((s) => `### ${s.heading}\n\n${s.body}`).join('\n\n');
  return { sections, text: text || '_There is no context for this ticket._' };
}
