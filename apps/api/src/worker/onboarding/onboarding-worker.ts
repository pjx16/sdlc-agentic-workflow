import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_GLOBAL_SETTINGS, GlobalSettingsSchema, ProjectSettingsSchema, defaultRouting, describeError, events,
  type CommandCheck, type ConfluenceSpace, type JiraFacts, type ModelAlias, type OnboardAdvice, type OnboardingFacts, type OnboardingProposal, type RepoProfile, type StageEnvelope, type TicketStatus,
} from '@sdlc/shared';
import { ConfluenceClients } from '../../confluence/confluence-clients';
import { logEvent } from '../../common/event-log';
import type { Prisma, Project } from '../../generated/prisma/client';
import { JiraClients, JiraNotConfiguredError } from '../../jira/jira-clients';
import { PrismaService } from '../../prisma/prisma.service';
import { SupportRaiser } from '../../support/support-raiser';
import { AgentRunner, type StageResult } from '../agent-runner/agent-runner';
import { GITHUB_CLIENT, type GitHubClient, parseRepo } from '../github/github-client';
import { GitRunner } from '../git/git-runner';
import { MirrorService } from '../git/mirror.service';
import { makeWritableForAgent } from '../git/workspace';
import type { Housekeeper } from '../loop/worker-loop';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';

const CHECKOUT_TIMEOUT_MS = 5 * 60_000;

/** The facts as plain text for the agents. */
export function factsText(projectName: string, facts: OnboardingFacts): string {
  const out = [`Project: ${projectName}`, `Default branch: ${facts.github.defaultBranch}`, `Languages (most used first): ${facts.github.languages.join(', ') || 'unknown'}`];
  if (facts.jira) {
    out.push('', `Jira project: ${facts.jira.projectName}`, 'Issue types:', ...facts.jira.issueTypes.map((t) => `- ${t.name}${t.subtask ? ' (the sub-task type)' : ''}`));
    out.push('', 'Statuses per issue type (name [category]):', ...facts.jira.statusesByType.map((t) => `- ${t.type}: ${t.statuses.map((s) => `${s.name} [${s.category}]`).join(', ')}`));
    out.push('', `Labels already in use: ${facts.jira.labels.join(', ') || 'none'}`);
  }
  if (facts.confluence.spaces) out.push('', 'Confluence spaces the person can write to:', ...(facts.confluence.spaces.length ? facts.confluence.spaces.map((s) => `- ${s.key}: ${s.name}`) : ['- none']));
  else out.push('', `Confluence is not available: ${facts.confluence.reason}`);
  return out.join('\n');
}

/**
 * The advisor only proposes: code checks that every name it used exists in the facts, so a proposal never carries an invented
 * status, issue type or space (BUILD_PLAN v1 6.7, principle 5).
 */
export function sanitizeAdvice(advice: OnboardAdvice | null, jira: JiraFacts | null, spaces: ConfluenceSpace[] | null): OnboardAdvice {
  const statuses = new Set((jira?.statusesByType ?? []).flatMap((t) => t.statuses.map((s) => s.name)));
  const known = (name: string | null | undefined) => (name && statuses.has(name) ? name : null);
  const fallback = defaultRouting(jira?.issueTypes ?? []);
  const routing: OnboardAdvice['issueTypeRouting'] = {};
  for (const t of jira?.issueTypes ?? []) {
    const proposed = advice?.issueTypeRouting[t.name];
    routing[t.name] = t.subtask ? 'ignore' : (proposed ?? fallback[t.name] ?? 'feature');
  }
  const statusMap: OnboardAdvice['statusMap'] = {};
  for (const [state, name] of Object.entries(advice?.statusMap ?? {})) statusMap[state as TicketStatus] = known(name as string | null);
  const label = advice?.intakeLabel && /^\S+$/.test(advice.intakeLabel) ? advice.intakeLabel : 'sdlc-agent';
  const space = advice?.confluenceSpaceKey && spaces?.some((s) => s.key === advice.confluenceSpaceKey) ? advice.confluenceSpaceKey : null;
  return { statusMap, approvalStatuses: { plan: known(advice?.approvalStatuses.plan), breakdown: known(advice?.approvalStatuses.breakdown) }, issueTypeRouting: routing, intakeLabel: label, confluenceSpaceKey: space };
}

/** Why an agent run did not return data, in the words of the error policy. */
function failureOf(stage: string, r: Exclude<StageResult, { kind: 'done' }>): string {
  switch (r.kind) {
    case 'needs_input':
      return `The ${stage} agent needs an answer it cannot ask during onboarding: ${r.question}`;
    case 'rate_limited':
      return describeError(r.errorCode ?? 'CLAUDE_USAGE_LIMIT', { time: r.resetsAt?.toLocaleTimeString() });
    case 'claude_auth':
      return describeError('CLAUDE_AUTH');
    case 'turn_limit':
      return describeError('TURN_LIMIT', { agent: stage });
    case 'killed':
      return `The ${stage} agent was stopped.`;
    case 'failed':
      return r.reason;
  }
}

/**
 * Onboarding (BUILD_PLAN v1 6.7): for a project in `profiling`, code collects the facts, `repo-profiler` proposes the commands, code
 * checks them once, `onboarding-advisor` proposes the Jira mapping, and the result waits as a proposal for the person to review.
 * Nothing is applied to the project until it is confirmed.
 */
@Injectable()
export class OnboardingWorker implements Housekeeper {
  readonly name = 'onboarding';
  readonly intervalMs = 5000;
  private readonly logger = new Logger(OnboardingWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WorkerConfig,
    private readonly mirrors: MirrorService,
    private readonly git: GitRunner,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
    private readonly jira: JiraClients,
    private readonly confluence: ConfluenceClients,
    private readonly runner: AgentRunner,
    private readonly verify: VerifyService,
    private readonly raiser: SupportRaiser,
  ) {}

  async check(): Promise<void> {
    if (this.running) return;
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    // Onboarding runs Claude: it waits while the pipeline is paused for limits, like the assistant.
    if (settings?.pipelinePaused && settings.pausedReason !== 'manual') return;
    const project = await this.prisma.project.findFirst({ where: { onboardingStatus: 'profiling' }, orderBy: { createdAt: 'asc' } });
    if (!project) return;
    this.running = true;
    try {
      await this.onboard(project);
    } finally {
      this.running = false;
    }
  }

  /** Runs the whole flow for one project. A failure leaves the project in `draft` with the reason, never half-configured. */
  async onboard(project: Project): Promise<void> {
    const checkout = path.join(this.config.dataDir, 'onboarding', project.id);
    try {
      const facts = await this.collectFacts(project);
      const baseBranch = facts.github.defaultBranch;
      await this.prisma.project.update({ where: { id: project.id }, data: { baseBranch, mirrorStatus: 'pending', mirrorError: null } });
      await this.mirrors.clone(await this.prisma.project.findUniqueOrThrow({ where: { id: project.id } }));
      const cloned = await this.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      if (cloned.mirrorStatus !== 'ok') throw new Error(cloned.mirrorError ?? 'The repository could not be cloned');

      const text = factsText(project.name, facts);
      const global = await this.global();
      const settings = ProjectSettingsSchema.parse(project.settings);

      await rm(checkout, { recursive: true, force: true });
      await mkdir(path.dirname(checkout), { recursive: true });
      await this.git.run(['clone', '--depth', '1', '--branch', baseBranch, '--', this.config.mirrorPath(project.id), checkout], { timeoutMs: CHECKOUT_TIMEOUT_MS });
      await makeWritableForAgent(checkout);

      const profile = await this.stage<RepoProfile>(project, 'repoProfile', { onboard: { facts: text } }, checkout, settings, global);
      const installCheck = await this.check1(project, 'install', profile.installCmd, checkout, global.verifyTimeoutSec);
      const typecheckCheck = installCheck && !installCheck.ok ? null : await this.check1(project, 'typecheck', profile.typecheckCmd, checkout, global.verifyTimeoutSec);

      const advice = facts.jira
        ? await this.stage<OnboardAdvice>(project, 'onboardAdvise', { onboard: { facts: text } }, undefined, settings, global)
        : null;
      const proposal: OnboardingProposal = {
        facts,
        profile: { ...profile, baseBranch, installCheck, typecheckCheck },
        advice: sanitizeAdvice(advice, facts.jira, facts.confluence.spaces),
        accepted: {},
        createdAt: new Date().toISOString(),
      };
      await this.prisma.project.update({ where: { id: project.id }, data: { onboardingStatus: 'proposed', onboardingError: null, onboardingProposal: proposal as unknown as Prisma.InputJsonValue } });
      await this.raiser.raise({
        kind: 'onboarding', projectId: project.id, stage: 'onboarding', dedupeKey: `onboarding:${project.id}`,
        title: `Review the setup of ${project.name}`,
        body: `The proposal for **${project.name}** is ready: commands, Jira statuses, issue types, the intake label and the Confluence space. Review each part, then confirm. Nothing is used until you do.`,
      });
      await logEvent(this.prisma, events.note({ source: 'system', type: 'system', message: `Onboarding proposal for ${project.name} is ready for review` }));
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.logger.warn(`Onboarding of "${project.name}" failed: ${message}`);
      await this.prisma.project.update({ where: { id: project.id }, data: { onboardingStatus: 'draft', onboardingError: message } });
      await logEvent(this.prisma, events.note({ source: 'system', type: 'error', level: 'error', message: `Onboarding of ${project.name} failed: ${message}` }));
    } finally {
      await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Step 1: code only, no AI. */
  async collectFacts(project: Project): Promise<OnboardingFacts> {
    let github;
    try {
      github = await this.github.repoFacts(parseRepo(project.repoUrl));
    } catch (err) {
      throw new Error(`GitHub: ${err instanceof Error ? err.message : String(err)}. Check the GitHub token in Settings → Connections and the repository URL.`, { cause: err });
    }
    let jira: JiraFacts | null = null;
    if (project.jiraMode === 'rest' && project.jiraProjectKey) {
      try {
        jira = await (await this.jira.forRest()).projectFacts(project.jiraProjectKey);
      } catch (err) {
        if (err instanceof JiraNotConfiguredError) throw new Error(`${err.message}. Or onboard without a Jira project key.`, { cause: err });
        throw new Error(`Jira: ${err instanceof Error ? err.message : String(err)}. Check the project key and the Jira credential.`, { cause: err });
      }
    }
    let confluence: OnboardingFacts['confluence'];
    try {
      confluence = { spaces: await (await this.confluence.forRest()).listWritableSpaces() };
    } catch (err) {
      confluence = { spaces: null, reason: err instanceof Error ? err.message : String(err) };
    }
    return { github, jira, confluence };
  }

  private async stage<T>(project: Project, stage: 'repoProfile' | 'onboardAdvise', inputs: { onboard: { facts: string } }, workspacePath: string | undefined, settings: ReturnType<typeof ProjectSettingsSchema.parse>, global: typeof DEFAULT_GLOBAL_SETTINGS): Promise<T> {
    const result = await this.runner.run({
      projectId: project.id,
      stage,
      stack: project.stack,
      claudeMdMode: 'theirs',
      modelAlias: settings.stages[stage].model as ModelAlias,
      modelAliases: global.modelAliases,
      maxTurns: settings.stages[stage].maxTurns,
      stageTimeoutMin: global.stageTimeoutMin,
      inputs,
      workspacePath,
    });
    if (result.kind !== 'done') throw new Error(failureOf(stage, result));
    return (result.envelope as StageEnvelope).data as T;
  }

  /** Runs one command once in an agent container and records whether it passed. An empty command is skipped. */
  private async check1(project: Project, what: string, command: string, workspace: string, timeoutSec: number): Promise<CommandCheck | null> {
    if (!command.trim()) return null;
    const r = await this.verify.runCmd({ name: `sdlc-onboard-${what}-${project.id.slice(0, 8)}`, workspace, cmd: command, timeoutSec });
    return { command, ok: r.ok, tail: r.timedOut ? `Timed out after ${timeoutSec} seconds` : r.tail };
  }

  private async global() {
    const row = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (!row) return DEFAULT_GLOBAL_SETTINGS;
    return GlobalSettingsSchema.parse({ stageTimeoutMin: row.stageTimeoutMin, verifyTimeoutSec: row.verifyTimeoutSec, modelAliases: row.modelAliases });
  }
}
