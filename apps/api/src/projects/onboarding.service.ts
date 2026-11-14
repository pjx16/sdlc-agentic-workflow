import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ErrorCodes, GlobalSettingsSchema, ISSUE_KINDS, MUST_ACCEPT, ONBOARDING_SECTIONS, PLANS_PARENT_PAGE_TITLE, ProjectSettingsSchema, RepoProfileData, TICKET_STATUSES, buildIntakeJql, defaultLocalKeyPrefix, events,
  type OnboardingProposal, type OnboardingSection, type OnboardingStatus, type TicketStatus,
} from '@sdlc/shared';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { logEvent } from '../common/event-log';
import { parseBody } from '../common/parse-body';
import { ConfluenceClients } from '../confluence/confluence-clients';
import { Prisma, type Project } from '../generated/prisma/client';
import { JiraClients } from '../jira/jira-clients';
import { PrismaService } from '../prisma/prisma.service';
import { SupportRaiser } from '../support/support-raiser';
import { type ProjectDto, toDto } from './project.dto';

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

const StartBody = z.object({
  repoUrl: z.string({ error: 'required' }).trim().min(1, 'required').refine((v) => GITHUB_URL.test(v), 'must be an HTTPS github.com repository URL'),
  jiraProjectKey: z.string().trim().optional().transform((v) => (v ? v : undefined)).refine((v) => v === undefined || /^[A-Z][A-Z0-9_]*$/.test(v), 'must be upper-case letters, digits or _'),
});

const SectionBody = z.object({ action: z.enum(['accept', 'edit']), value: z.record(z.string(), z.unknown()).optional() });

export interface OnboardingDto {
  status: OnboardingStatus;
  error: string | null;
  proposal: OnboardingProposal | null;
}

export interface DryRunDto {
  jql: string;
  count: number;
  /** Up to five tickets that match now. */
  tickets: { key: string; summary: string; issueType: string }[];
  /** Said when nothing matches because nobody has used the label yet. */
  note: string | null;
}

export interface ConfirmDto {
  project: ProjectDto;
  /** Things that did not work but do not stop the project (for example Confluence). */
  warnings: string[];
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraClients,
    private readonly confluence: ConfluenceClients,
    private readonly raiser: SupportRaiser,
  ) {}

  /** POST /projects/onboard: a repo URL and, optionally, a Jira project key. The worker does the rest. */
  async start(body: unknown): Promise<ProjectDto> {
    const { repoUrl, jiraProjectKey } = parseBody(StartBody, body);
    const [, owner = '', repo = ''] = GITHUB_URL.exec(repoUrl) ?? [];
    const names = [repo, `${owner}-${repo}`, `${owner}-${repo}-2`];
    for (const name of names) {
      try {
        const project = await this.prisma.project.create({
          data: {
            name,
            repoUrl,
            // Placeholders until the proposal is confirmed: the worker ignores the project until then.
            stack: 'ts_node',
            testCmdTemplate: 'echo {files}',
            localKeyPrefix: jiraProjectKey ?? defaultLocalKeyPrefix(repo),
            jiraMode: jiraProjectKey ? 'rest' : 'off',
            jiraProjectKey: jiraProjectKey ?? null,
            onboardingStatus: 'profiling',
            mirrorStatus: 'pending',
          },
        });
        await logEvent(this.prisma, events.note({ source: 'user', type: 'system', message: `Onboarding of ${name} started` }));
        return toDto(project);
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { repoUrl: 'a project for this repository already exists' });
  }

  private async project(id: string): Promise<Project> {
    const p = await this.prisma.project.findUnique({ where: { id } });
    if (!p) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Project not found');
    return p;
  }

  private proposalOf(p: Project): OnboardingProposal | null {
    return (p.onboardingProposal as unknown as OnboardingProposal | null) ?? null;
  }

  async get(id: string): Promise<OnboardingDto> {
    const p = await this.project(id);
    return { status: p.onboardingStatus, error: p.onboardingError, proposal: this.proposalOf(p) };
  }

  /** POST /projects/:id/onboarding/rerun: a new proposal. Settings do not change until it is confirmed again, and the worker ignores the project meanwhile. */
  async rerun(id: string): Promise<OnboardingDto> {
    const p = await this.project(id);
    if (p.onboardingStatus === 'profiling') throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The project is already being profiled');
    await this.raiser.close({ projectId: id, kind: 'onboarding' }, 'dismissed', 'user', 'Replaced by a new proposal');
    await this.prisma.project.update({ where: { id }, data: { onboardingStatus: 'profiling', onboardingError: null } });
    return this.get(id);
  }

  /** PATCH /projects/:id/onboarding/sections/:section: accept the proposal as it is, or edit it (which counts as accepting). */
  async section(id: string, section: string, body: unknown): Promise<OnboardingDto> {
    const p = await this.project(id);
    if (!(ONBOARDING_SECTIONS as readonly string[]).includes(section)) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Unknown section');
    const { action, value } = parseBody(SectionBody, body);
    const proposal = this.proposalOf(p);
    if (p.onboardingStatus !== 'proposed' || !proposal) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'There is no proposal to review yet');
    if (action === 'edit') this.apply(proposal, section as OnboardingSection, parseBody(z.record(z.string(), z.unknown()), value ?? {}));
    proposal.accepted = { ...proposal.accepted, [section]: true };
    await this.prisma.project.update({ where: { id }, data: { onboardingProposal: proposal as unknown as Prisma.InputJsonValue } });
    return this.get(id);
  }

  /** Edits one section, checking it against the facts: a status must exist in Jira, a space must be one the person can write to. */
  private apply(proposal: OnboardingProposal, section: OnboardingSection, value: Record<string, unknown>): void {
    const jira = proposal.facts.jira;
    switch (section) {
      case 'commands': {
        const merged = parseBody(RepoProfileData, { ...proposal.profile, ...value });
        const branch = value.baseBranch === undefined ? proposal.profile.baseBranch : parseBody(z.object({ baseBranch: z.string().trim().min(1, 'required').refine((v) => !/\s/.test(v), 'must not contain spaces') }), { baseBranch: value.baseBranch }).baseBranch;
        proposal.profile = { ...proposal.profile, ...merged, baseBranch: branch };
        return;
      }
      case 'statusMap': {
        if (!jira) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { statusMap: 'this project has no Jira project to map to' });
        const known = new Set(jira.statusesByType.flatMap((t) => t.statuses.map((s) => s.name)));
        const status = z.string().nullable().refine((v) => v === null || known.has(v), 'is not a status of this Jira project');
        const parsed = parseBody(z.object({ statusMap: z.partialRecord(z.enum(TICKET_STATUSES), status).optional(), approvalStatuses: z.object({ plan: status, breakdown: status }).partial().optional() }), value);
        proposal.advice = { ...proposal.advice, statusMap: { ...proposal.advice.statusMap, ...(parsed.statusMap as Partial<Record<TicketStatus, string | null>> | undefined) }, approvalStatuses: { ...proposal.advice.approvalStatuses, ...parsed.approvalStatuses } };
        return;
      }
      case 'routing': {
        if (!jira) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { routing: 'this project has no Jira project to route' });
        const types = new Set(jira.issueTypes.map((t) => t.name));
        const parsed = parseBody(z.object({ issueTypeRouting: z.record(z.string(), z.enum(ISSUE_KINDS)) }), value);
        const unknown = Object.keys(parsed.issueTypeRouting).filter((k) => !types.has(k));
        if (unknown.length > 0) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { issueTypeRouting: `${unknown.join(', ')} is not an issue type of this Jira project` });
        proposal.advice = { ...proposal.advice, issueTypeRouting: { ...proposal.advice.issueTypeRouting, ...parsed.issueTypeRouting } };
        return;
      }
      case 'label': {
        const parsed = parseBody(z.object({ intakeLabel: z.string().trim().min(1, 'required').regex(/^\S+$/, 'must not contain spaces') }), value);
        proposal.advice = { ...proposal.advice, intakeLabel: parsed.intakeLabel };
        return;
      }
      case 'confluence': {
        const spaces = proposal.facts.confluence.spaces;
        const parsed = parseBody(z.object({ confluenceSpaceKey: z.string().nullable() }), value);
        if (parsed.confluenceSpaceKey !== null && !spaces?.some((s) => s.key === parsed.confluenceSpaceKey)) {
          throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { confluenceSpaceKey: 'is not a space you can write to' });
        }
        proposal.advice = { ...proposal.advice, confluenceSpaceKey: parsed.confluenceSpaceKey };
      }
    }
  }

  /** POST /projects/:id/onboarding/dry-run: how many tickets the intake query would pick up now, and the first five. */
  async dryRun(id: string): Promise<DryRunDto> {
    const p = await this.project(id);
    const proposal = this.proposalOf(p);
    if (!proposal || !p.jiraProjectKey) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'There is no Jira project to look at');
    const jql = buildIntakeJql({ projectKey: p.jiraProjectKey, label: proposal.advice.intakeLabel, routing: proposal.advice.issueTypeRouting });
    let found;
    try {
      found = await (await this.jira.forRest()).searchTickets({ jiraProjectKey: p.jiraProjectKey, jiraJql: jql });
    } catch (err) {
      throw new ApiException(HttpStatus.BAD_GATEWAY, ErrorCodes.jiraError, err instanceof Error ? err.message : 'Jira request failed');
    }
    const used = proposal.facts.jira?.labels.includes(proposal.advice.intakeLabel) ?? false;
    return {
      jql,
      count: found.length,
      tickets: found.slice(0, 5).map((t) => ({ key: t.key, summary: t.summary, issueType: t.issuetype })),
      note: found.length === 0 && !used ? `Label not used yet. Add the label "${proposal.advice.intakeLabel}" to a Jira ticket to start. Jira creates a label the first time it is applied.` : null,
    };
  }

  /** POST /projects/:id/onboarding/confirm: applies the proposal. The status map and the label must have been accepted. */
  async confirm(id: string): Promise<ConfirmDto> {
    const p = await this.project(id);
    const proposal = this.proposalOf(p);
    if (p.onboardingStatus !== 'proposed' || !proposal) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'There is no proposal to confirm');
    const missing = MUST_ACCEPT.filter((s) => !proposal.accepted[s] && (s === 'label' ? Boolean(p.jiraProjectKey) : Boolean(proposal.facts.jira)));
    if (missing.length > 0) {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `Accept these first: ${missing.join(', ')}`, Object.fromEntries(missing.map((s) => [s, 'must be accepted'])));
    }
    const warnings: string[] = [];
    const { profile, advice, facts } = proposal;
    const settings = ProjectSettingsSchema.parse(p.settings);

    let confluence: { spaceKey: string; parentPageId: string | null } | null = null;
    if (advice.confluenceSpaceKey) {
      try {
        const page = await (await this.confluence.forRest()).ensureParentPage(advice.confluenceSpaceKey, PLANS_PARENT_PAGE_TITLE);
        confluence = { spaceKey: advice.confluenceSpaceKey, parentPageId: page.id };
      } catch (err) {
        warnings.push(`Confluence: ${err instanceof Error ? err.message : String(err)}. The project works without it; plans go to Jira comments.`);
      }
    }
    // New projects start with the models and turn limits chosen in Settings (BUILD_PLAN v1 6.7).
    const row = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const defaults = GlobalSettingsSchema.parse({ stageDefaults: row?.stageDefaults ?? {} }).stageDefaults;
    const stages = Object.fromEntries(Object.entries(settings.stages).map(([stage, current]) => [stage, { ...current, ...(defaults[stage as keyof typeof defaults] ?? {}) }]));
    const subtaskType = facts.jira?.issueTypes.find((t) => t.subtask)?.name;
    const nextSettings = {
      ...settings,
      stages,
      jiraStatusMap: { ...settings.jiraStatusMap, ...Object.fromEntries(TICKET_STATUSES.map((s) => [s, advice.statusMap[s] ?? null])) },
      jiraApprovalStatuses: { plan: advice.approvalStatuses.plan ?? undefined, breakdown: advice.approvalStatuses.breakdown ?? undefined },
      jiraIssueTypeRouting: advice.issueTypeRouting,
      ...(subtaskType ? { jiraSubtaskTypeName: subtaskType } : {}),
      confluence,
    };
    const updated = await this.prisma.project.update({
      where: { id },
      data: {
        stack: profile.stack,
        installCmd: profile.installCmd,
        typecheckCmd: profile.typecheckCmd,
        testCmdTemplate: profile.testCmdTemplate,
        kbDir: profile.kbDir,
        baseBranch: profile.baseBranch,
        jiraMode: p.jiraProjectKey ? 'rest' : 'off',
        jiraJql: p.jiraProjectKey ? buildIntakeJql({ projectKey: p.jiraProjectKey, label: advice.intakeLabel, routing: advice.issueTypeRouting }) : null,
        settings: nextSettings as unknown as Prisma.InputJsonValue,
        // A changed base branch needs a fresh mirror; otherwise the one the worker made stays.
        ...(profile.baseBranch !== p.baseBranch ? { mirrorStatus: 'pending', mirrorError: null } : {}),
        onboardingStatus: 'confirmed',
        onboardingError: null,
      },
    });
    await this.raiser.close({ projectId: id, kind: 'onboarding' }, 'resolved', 'user', 'The proposal was confirmed');
    await logEvent(this.prisma, events.note({ source: 'user', type: 'system', message: `Onboarding of ${p.name} confirmed` }));
    return { project: toDto(updated), warnings };
  }
}
