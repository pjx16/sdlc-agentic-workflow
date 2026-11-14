import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProjectSettingsSchema } from '@sdlc/shared';
import type { StageArtifact, Ticket } from '../../generated/prisma/client';
import { ConfluenceClients } from '../../confluence/confluence-clients';
import { ConfluenceHub, type DocumentHub, type HubDocument } from '../../confluence/document-hub';
import { JiraClients } from '../../jira/jira-clients';
import { jiraMarker } from '../../jira/jira-client';
import { PrismaService } from '../../prisma/prisma.service';
import type { TransitionListener, TransitionResult } from '../../state/state-machine.service';
import { FormatLoader } from '../format-loader';
import type { Housekeeper } from '../loop/worker-loop';

const EARLY = ['NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL'];
/** Waits before each of the 3 attempts: the first is immediate, the next ones give Confluence time to recover. */
export const RETRY_DELAYS_MS = [0, 2000, 6000];
const SUPERSEDED = 'Superseded by a rerun: a new plan is being written';

/**
 * Keeps one Confluence page per ticket in step with its plan (BUILD_PLAN v1 6.10). Every poll it compares what the page should say (the
 * current plan, its status line, the answered questions) with what was last sent, and publishes or updates when they differ. That one
 * rule covers the first publish, a rerun, an approval and an answered question. A Confluence failure is tried 3 times, then the plan goes to
 * Jira as a comment, a warning is recorded, and nothing blocks (CONFLUENCE_ERROR).
 */
@Injectable()
export class PlanPageSync implements Housekeeper, TransitionListener {
  readonly name = 'plan-pages';
  readonly intervalMs = (pollIntervalSec: number) => pollIntervalSec;
  private readonly logger = new Logger(PlanPageSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly confluence: ConfluenceClients,
    private readonly jira: JiraClients,
    private readonly hubOf: (client: Awaited<ReturnType<ConfluenceClients['forRest']>>) => DocumentHub = (c) => new ConfluenceHub(c),
    private readonly delaysMs: readonly number[] = RETRY_DELAYS_MS,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    @Optional() formats?: FormatLoader,
  ) {
    this.formats = formats ?? new FormatLoader();
  }

  private readonly formats: FormatLoader;

  /**
   * The page follows a ticket at the moment it moves, not at the next poll: an approval, a rejection, or a rerun that supersedes the plan
   * updates the page straight away. The poll below stays as the safety net (a missed move, a Confluence outage that has ended).
   */
  async onTransition({ ticket, transition }: TransitionResult): Promise<void> {
    const watched = ['AWAITING_PLAN_APPROVAL', 'PLANNING'];
    if (!watched.includes(transition.fromStatus) && !watched.includes(transition.toStatus) && transition.kind !== 'rerun') return;
    // The first publish is left to the poll, which runs in one process only: two processes could each create the page.
    await this.syncTicket(ticket, { createIfMissing: false });
  }

  async check(): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({ where: { project: { enabled: true }, status: { notIn: ['DONE', 'FAILED'] }, artifacts: { some: { stage: 'plan' } } }, orderBy: { createdAt: 'asc' } });
    for (const ticket of tickets) {
      try {
        await this.syncTicket(ticket);
      } catch (err) {
        this.logger.warn(`Plan page of ${ticket.key} could not be synced: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async syncTicket(ticket: Ticket, options: { createIfMissing?: boolean } = {}): Promise<void> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const parentId = settings.confluence?.parentPageId;
    if (!parentId) return; // Without Confluence the plan is a Jira comment, as before (the plan handler posts it).

    const artifacts = await this.prisma.stageArtifact.findMany({ where: { ticketId: ticket.id, stage: 'plan' }, orderBy: { version: 'desc' } });
    const live = artifacts.find((a) => a.supersededAt === null);
    // A rerun is under way when every plan is superseded: the page keeps the last plan, marked as superseded, until the new one is written.
    const current = live ?? artifacts[0];
    if (!current) return;
    const owner = artifacts.find((a) => a.externalId);
    if (!owner && (!live || options.createIfMissing === false)) return; // Nothing was published yet: nothing to mark or update.

    const doc = await this.document(ticket, current, !live);
    const sig = createHash('sha1').update(`${doc.title}\n${doc.status}\n${doc.markdown}`).digest('hex');
    if (current.externalSig === sig) return;

    let lastError: unknown;
    for (let attempt = 0; attempt < this.delaysMs.length; attempt++) {
      if ((this.delaysMs[attempt] ?? 0) > 0) await this.sleep(this.delaysMs[attempt] as number);
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
        await this.linkOnJira(ticket, project.jiraMode, settings.jiraWriteBack.comments, page.url, doc.status);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    // Retried 3 times: fall back to the full plan in Jira, once for this content, and carry on.
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    await this.event(ticket, 'warn', `Confluence failed: ${detail}. The plan was posted to Jira instead.`, true);
    if (live) await this.fullTextOnJira(ticket, project.jiraMode, settings.jiraWriteBack.comments, current);
    await this.prisma.stageArtifact.update({ where: { id: current.id }, data: { externalSig: sig } });
  }

  /** The page's content and status line for the plan as it stands now. */
  private async document(ticket: Ticket, current: StageArtifact, superseded: boolean): Promise<HubDocument> {
    const data = current.data as { planMarkdown?: string };
    const answered = await this.prisma.supportTicket.findMany({ where: { ticketId: ticket.id, kind: 'open_question', response: { not: null } }, orderBy: { createdAt: 'asc' } });
    const answers = answered.length > 0 ? `\n\n## Answered questions\n\n${answered.map((q) => `- ${q.body}: ${q.response}`).join('\n')}` : '';
    let status = 'Draft, waiting for approval';
    if (superseded) status = SUPERSEDED;
    else if (!EARLY.includes(ticket.status)) {
      const t = await this.prisma.stateTransition.findFirst({ where: { ticketId: ticket.id, fromStatus: 'AWAITING_PLAN_APPROVAL' }, orderBy: { at: 'desc' } });
      const when = (t?.at ?? new Date()).toISOString().slice(0, 10);
      status = `Approved on ${when}`;
    }
    return { title: `${ticket.key} — ${ticket.title}`.slice(0, 250), markdown: `${data.planMarkdown ?? ''}${answers}`, status };
  }

  /** One comment with the page link and the page's status. It is edited in place as the status changes (its marker does not change). */
  private async linkOnJira(ticket: Ticket, jiraMode: string, enabled: boolean, url: string, status: string): Promise<void> {
    if (!enabled || jiraMode !== 'rest' || ticket.source !== 'jira' || !ticket.externalKey || !url) return;
    try {
      await (await this.jira.forRest()).upsertComment(ticket.externalKey, await this.formats.fill('jira-plan-link', { key: ticket.key, url, status }), jiraMarker(ticket.key, 'plan-link'));
    } catch (err) {
      await this.event(ticket, 'warn', `Could not post the plan link to Jira: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private async fullTextOnJira(ticket: Ticket, jiraMode: string, enabled: boolean, current: StageArtifact): Promise<void> {
    if (!enabled || jiraMode !== 'rest' || ticket.source !== 'jira' || !ticket.externalKey) return;
    const plan = (current.data as { planMarkdown?: string }).planMarkdown ?? '';
    try {
      await (await this.jira.forRest()).comment(ticket.externalKey, await this.formats.fill('jira-plan', { key: ticket.key, plan }), jiraMarker(ticket.key, 'plan', plan));
    } catch (err) {
      await this.event(ticket, 'warn', `Could not post the plan to Jira: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private event(ticket: Ticket, level: 'warn' | 'info', message: string, failure: boolean) {
    return this.prisma.event.create({ data: { ticketId: ticket.id, type: 'confluence', level, source: 'confluence', message: message.slice(0, 500), ...(failure ? { errorCode: 'CONFLUENCE_ERROR' } : {}) } }).catch(() => undefined);
  }
}
