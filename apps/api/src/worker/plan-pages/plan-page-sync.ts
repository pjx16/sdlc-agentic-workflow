import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import type { StageArtifact, Ticket } from '../../generated/prisma/client';
import { ConfluenceClients } from '../../confluence/confluence-clients';
import { ConfluenceHub, type DocumentHub, type HubDocument } from '../../confluence/document-hub';
import { JiraClients } from '../../jira/jira-clients';
import { jiraMarker } from '../../jira/jira-client';
import { PrismaService } from '../../prisma/prisma.service';
import type { Housekeeper } from '../loop/worker-loop';

const EARLY = ['NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL'];
const ATTEMPTS = 3;

/**
 * Keeps one Confluence page per ticket in step with its plan (BUILD_PLAN v1 6.10). Every poll it compares what the page should say (the
 * current plan, its status line, the answered questions) with what was last sent, and publishes or updates when they differ. That one
 * rule covers the first publish, a rerun, an approval and an answered question. A Confluence failure is tried 3 times, then the plan goes to
 * Jira as a comment, a warning is recorded, and nothing blocks (CONFLUENCE_ERROR).
 */
@Injectable()
export class PlanPageSync implements Housekeeper {
  readonly name = 'plan-pages';
  readonly intervalMs = (pollIntervalSec: number) => pollIntervalSec;
  private readonly logger = new Logger(PlanPageSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly confluence: ConfluenceClients,
    private readonly jira: JiraClients,
    private readonly hubOf: (client: Awaited<ReturnType<ConfluenceClients['forRest']>>) => DocumentHub = (c) => new ConfluenceHub(c),
  ) {}

  async check(): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({ where: { project: { enabled: true }, artifacts: { some: { stage: 'plan', supersededAt: null } } }, orderBy: { createdAt: 'asc' } });
    for (const ticket of tickets) {
      try {
        await this.syncTicket(ticket);
      } catch (err) {
        this.logger.warn(`Plan page of ${ticket.key} could not be synced: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async syncTicket(ticket: Ticket): Promise<void> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const parentId = settings.confluence?.parentPageId;
    if (!parentId) return; // Without Confluence the plan is a Jira comment, as before (the plan handler posts it).

    const artifacts = await this.prisma.stageArtifact.findMany({ where: { ticketId: ticket.id, stage: 'plan' }, orderBy: { version: 'desc' } });
    const current = artifacts.find((a) => a.supersededAt === null);
    if (!current) return; // A rerun is under way: the new plan updates the same page when it is written.
    const owner = artifacts.find((a) => a.externalId);

    const doc = await this.document(ticket, current);
    const sig = createHash('sha1').update(`${doc.title}\n${doc.status}\n${doc.markdown}`).digest('hex');
    if (current.externalSig === sig) return;

    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const hub = this.hubOf(await this.confluence.forRest());
        let page: { id: string; url: string; version: number };
        if (owner?.externalId) {
          const r = await hub.update(owner.externalId, owner.externalVersion ?? 1, doc);
          page = { id: owner.externalId, url: owner.externalUrl ?? '', version: r.version };
          if (r.conflicted) await this.event(ticket, 'warn', `The Confluence page of ${ticket.key} was edited outside sdlc-agent; the update was applied on top of it`, false);
        } else {
          page = await hub.publish({ parentId, doc });
        }
        await this.prisma.stageArtifact.update({ where: { id: current.id }, data: { externalId: page.id, externalUrl: page.url, externalVersion: page.version, externalSig: sig } });
        await this.linkOnJira(ticket, project.jiraMode, settings.jiraWriteBack.comments, page.url);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    // Retried 3 times: fall back to the full plan in Jira, once for this content, and carry on.
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    await this.event(ticket, 'warn', `Confluence failed: ${detail}. The plan was posted to Jira instead.`, true);
    await this.fullTextOnJira(ticket, project.jiraMode, settings.jiraWriteBack.comments, current);
    await this.prisma.stageArtifact.update({ where: { id: current.id }, data: { externalSig: sig } });
  }

  /** The page's content and status line for the plan as it stands now. */
  private async document(ticket: Ticket, current: StageArtifact): Promise<HubDocument> {
    const data = current.data as { planMarkdown?: string };
    const answered = await this.prisma.supportTicket.findMany({ where: { ticketId: ticket.id, kind: 'open_question', response: { not: null } }, orderBy: { createdAt: 'asc' } });
    const answers = answered.length > 0 ? `\n\n## Answered questions\n\n${answered.map((q) => `- ${q.body}: ${q.response}`).join('\n')}` : '';
    let status = 'Draft, waiting for approval';
    if (!EARLY.includes(ticket.status)) {
      const t = await this.prisma.stateTransition.findFirst({ where: { ticketId: ticket.id, fromStatus: 'AWAITING_PLAN_APPROVAL' }, orderBy: { at: 'desc' } });
      const when = (t?.at ?? new Date()).toISOString().slice(0, 10);
      status = `Approved on ${when}`;
    }
    return { title: `${ticket.key} — ${ticket.title}`.slice(0, 250), markdown: `${data.planMarkdown ?? ''}${answers}`, status };
  }

  /** One comment with the page link, posted once (its marker does not change with the content). */
  private async linkOnJira(ticket: Ticket, jiraMode: string, enabled: boolean, url: string): Promise<void> {
    if (!enabled || jiraMode !== 'rest' || ticket.source !== 'jira' || !ticket.externalKey || !url) return;
    try {
      await (await this.jira.forRest()).comment(ticket.externalKey, `The plan for ${ticket.key} is in Confluence: ${url}`, jiraMarker(ticket.key, 'plan-link'));
    } catch (err) {
      await this.event(ticket, 'warn', `Could not post the plan link to Jira: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private async fullTextOnJira(ticket: Ticket, jiraMode: string, enabled: boolean, current: StageArtifact): Promise<void> {
    if (!enabled || jiraMode !== 'rest' || ticket.source !== 'jira' || !ticket.externalKey) return;
    const plan = (current.data as { planMarkdown?: string }).planMarkdown ?? '';
    try {
      await (await this.jira.forRest()).comment(ticket.externalKey, `## Plan for ${ticket.key}\n\n${plan}`, jiraMarker(ticket.key, 'plan', plan));
    } catch (err) {
      await this.event(ticket, 'warn', `Could not post the plan to Jira: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private event(ticket: Ticket, level: 'warn' | 'info', message: string, failure: boolean) {
    return this.prisma.event.create({ data: { ticketId: ticket.id, type: 'confluence', level, source: 'confluence', message: message.slice(0, 500), ...(failure ? { errorCode: 'CONFLUENCE_ERROR' } : {}) } }).catch(() => undefined);
  }
}
