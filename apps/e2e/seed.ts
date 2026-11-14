import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../api/src/generated/prisma/client.ts';

export const SEED = {
  project: 'Billing',
  plan: { key: 'BIL-1', title: 'Export bookings to CSV' },
  breakdown: { key: 'BIL-2', title: 'Add invoice numbers' },
  review: { key: 'BIL-3', title: 'Fix rounding of totals' },
  question: 'Which currency should the CSV use?',
} as const;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

/** A small world: one ready project, tickets at both gates and in review, an open question, usage history and stage runs for the charts. */
export async function seed(databaseUrl: string): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const project = await prisma.project.create({
      data: { name: SEED.project, repoUrl: 'https://github.com/acme/billing', stack: 'ts_node', testCmdTemplate: 'npx vitest run {files}', installCmd: 'npm ci', localKeyPrefix: 'BIL', mirrorStatus: 'ok', nextLocalNumber: 10 },
    });
    const ticket = (key: string, title: string, status: string, over: Record<string, unknown> = {}) =>
      prisma.ticket.create({ data: { projectId: project.id, key, source: 'paste', title, body: `${title}.\n\nDetails of the change.`, status: status as never, ...over } });

    await ticket(SEED.plan.key, SEED.plan.title, 'AWAITING_PLAN_APPROVAL', { planMarkdown: '# Plan\n\n- Add an export endpoint\n- Stream rows as CSV' });
    await ticket(SEED.breakdown.key, SEED.breakdown.title, 'AWAITING_BREAKDOWN_APPROVAL', {
      planMarkdown: '# Plan\n\nAdd numbers.',
      breakdownDraft: [
        { seq: 1, title: 'Add the counter', description: 'Store the next invoice number.', acceptanceCriteria: ['Numbers never repeat'], files: ['src/invoice.ts'], dependsOn: [] },
        { seq: 2, title: 'Show it on the invoice', description: 'Print the number.', acceptanceCriteria: ['The number is on the PDF'], files: ['src/pdf.ts'], dependsOn: [1] },
      ],
    });
    const review = await ticket(SEED.review.key, SEED.review.title, 'IN_HUMAN_REVIEW', { prNumber: 7, prUrl: 'https://github.com/acme/billing/pull/7', reviewRound: 1 });
    const asking = await ticket('BIL-4', 'Currency handling', 'ON_HOLD', { holdReason: 'awaiting_answer', holdFromStatus: 'PLANNING' });
    await ticket('BIL-5', 'Queued ticket', 'NEW');
    await ticket('BIL-6', 'Shipped ticket', 'DONE', { prNumber: 3, prUrl: 'https://github.com/acme/billing/pull/3', mergedAt: new Date(), prAdditions: 240, prDeletions: 60, prChangedFiles: 5 });

    const run = (over: Record<string, unknown>) =>
      prisma.stageRun.create({ data: { projectId: project.id, ticketId: review.id, stage: 'solutionDesign', model: 'opus', attempt: 1, status: 'succeeded', startedAt: hoursAgo(3), endedAt: hoursAgo(2.9), inputTokens: 4000, outputTokens: 900, cacheWriteTokens: 300, ...over } as never });
    await run({});
    await run({ stage: 'implement', model: 'haiku', startedAt: hoursAgo(2.5), endedAt: hoursAgo(2.3), inputTokens: 9000, outputTokens: 2500 });
    await run({ stage: 'fix', reason: 'review', model: 'sonnet', startedAt: hoursAgo(2), endedAt: hoursAgo(1.9), status: 'failed', error: 'Timed out after 20 minutes' });
    await run({ stage: 'prReview', model: 'sonnet', startedAt: hoursAgo(26), endedAt: hoursAgo(25.9) });
    const asked = await run({ ticketId: asking.id, stage: 'solutionDesign', status: 'needs_input', startedAt: hoursAgo(1), endedAt: hoursAgo(0.9) });
    await prisma.supportTicket.create({ data: { kind: 'question', title: SEED.question, body: SEED.question, ticketId: asking.id, projectId: asking.projectId, stageRunId: asked.id, stage: 'solutionDesign' } });
    await prisma.reviewFinding.createMany({
      data: [
        { ticketId: review.id, round: 1, severity: 'high', file: 'src/export.ts', line: 12, issue: 'Unvalidated input', rule: 'Security', fix: 'Validate', status: 'open' },
        { ticketId: review.id, round: 1, severity: 'low', file: 'src/export.ts', line: null, issue: 'Name', rule: 'Practices', fix: 'Rename', status: 'open' },
      ],
    });
    for (const [h, five, seven] of [[6, 10, 4], [4, 25, 5], [2, 41, 6], [1, 55, 7]] as const) {
      await prisma.usageSnapshot.create({ data: { at: hoursAgo(h), fiveHourPct: five, sevenDayPct: seven, status: five >= 50 ? 'allowed_warning' : 'allowed', source: 'event', resetsAt: hoursAgo(-3) } });
    }
    await prisma.event.create({ data: { type: 'usage', message: 'Pipeline paused: 5-hour usage is at 55% (threshold 50%)', at: hoursAgo(1) } });
    await prisma.stateTransition.create({ data: { ticketId: review.id, fromStatus: 'AWAITING_CI', toStatus: 'IN_HUMAN_REVIEW', actor: 'system', at: hoursAgo(1.5) } });
    await prisma.globalSettings.upsert({ where: { id: 'global' }, update: {}, create: { id: 'global' } });
  } finally {
    await prisma.$disconnect();
  }
}
