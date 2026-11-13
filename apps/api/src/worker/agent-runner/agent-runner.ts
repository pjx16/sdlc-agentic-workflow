import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CredentialsService } from '../../credentials/credentials.service';
import { stageJsonSchema, type ClaudeMdMode, type ModelAlias, type ProjectStack, type StageEnvelope, type StageName } from '@sdlc/shared';
import type { FixReason } from '../../generated/prisma/client';
import { USAGE_GATE, type UsageGatePort } from '../usage/usage-gate';
import { WorkerConfig } from '../worker-config';
import { buildStageContext, type StageInputs } from './context-builder';
import type { ContainerSpec } from './container-options';
import { ContainerRunner } from './container-runner';
import { LOG_SINK, type LogSink } from './log-sink';
import { isRateLimited, parseStream, type ParsedStream, type RateLimit } from './result-parser';
import { STAGE_WORKSPACE, isJiraStage } from './stage-config';
import { STAGE_RUN_STORE, type StageRunStore } from './stage-run-store';

const MAX_ATTEMPTS = 2; // BUILD_PLAN 6.8: retry once with a fresh run

export interface StageRequest {
  projectId: string;
  ticketId?: string;
  subtaskId?: string;
  stage: StageName;
  /** Set on `fix` runs. */
  reason?: FixReason;
  round?: number;
  stack: ProjectStack;
  claudeMdMode: ClaudeMdMode;
  modelAlias: ModelAlias;
  modelAliases: Record<ModelAlias, string>;
  maxTurns: number;
  stageTimeoutMin: number;
  inputs: StageInputs;
  /** Required for every stage that has a workspace (all but the Jira stages). */
  workspacePath?: string;
  /** Jira MCP stages only: tool names, the MCP config file contents and extra env (the Jira credential). */
  jira?: { tools: string[]; mcpConfigJson: string; env: Record<string, string>; serverName?: string };
  /** Orchestrator validation of a valid envelope (for example "featureKey must be in the index"). Return a message to fail the attempt. */
  validate?: (envelope: StageEnvelope) => string | null;
}

export type StageResult =
  | { kind: 'done'; envelope: StageEnvelope; stageRunId: string; attempts: number }
  | { kind: 'needs_input'; question: string; stageRunId: string; attempts: number }
  /** Both attempts failed: the ticket goes on hold (needs_help). */
  | { kind: 'failed'; reason: string; stageRunId: string; attempts: number }
  /** Reached the turn limit: on hold (needs_help) immediately, no retry. */
  | { kind: 'turn_limit'; stageRunId: string; attempts: number }
  /** Pause the pipeline and re-queue the stage; not counted as an attempt. */
  | { kind: 'rate_limited'; resetsAt: Date | null; stageRunId: string; attempts: number }
  /** Killed from the dashboard: the ticket goes on hold (manual). */
  | { kind: 'killed'; stageRunId: string; attempts: number };

/** Runs one AI stage end to end (BUILD_PLAN 6.4 and 6.8). */
/** What Claude Code / the API print when the token is not accepted. */
const AUTH_FAILURE = /authentication_error|invalid bearer token|oauth token (has )?expired|invalid api key/i;

@Injectable()
export class AgentRunner {
  private readonly logger = new Logger(AgentRunner.name);

  constructor(
    private readonly containers: ContainerRunner,
    private readonly config: WorkerConfig,
    private readonly creds: CredentialsService,
    @Inject(STAGE_RUN_STORE) private readonly store: StageRunStore,
    @Inject(LOG_SINK) private readonly logs: LogSink,
    @Optional() @Inject(USAGE_GATE) private readonly gate?: UsageGatePort,
  ) {}

  async run(req: StageRequest): Promise<StageResult> {
    let lastReason = 'unknown';
    let stageRunId = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await this.runAttempt(req, attempt);
      stageRunId = outcome.stageRunId;
      switch (outcome.kind) {
        case 'done':
        case 'needs_input':
        case 'turn_limit':
        case 'rate_limited':
        case 'killed':
          return { ...outcome, attempts: attempt } as StageResult;
        case 'failed':
          lastReason = outcome.reason;
          this.logger.warn(`Stage ${req.stage} attempt ${attempt} failed: ${outcome.reason}`);
      }
    }
    return { kind: 'failed', reason: lastReason, stageRunId, attempts: MAX_ATTEMPTS };
  }

  private async runAttempt(
    req: StageRequest,
    attempt: number,
  ): Promise<
    | { kind: 'done'; envelope: StageEnvelope; stageRunId: string }
    | { kind: 'needs_input'; question: string; stageRunId: string }
    | { kind: 'failed'; reason: string; stageRunId: string }
    | { kind: 'turn_limit'; stageRunId: string }
    | { kind: 'rate_limited'; resetsAt: Date | null; stageRunId: string }
    | { kind: 'killed'; stageRunId: string }
  > {
    const jira = isJiraStage(req.stage);
    const access = STAGE_WORKSPACE[req.stage];
    if (access !== 'none' && !req.workspacePath) throw new Error(`Stage ${req.stage} needs a workspace`);

    const model = req.modelAliases[req.modelAlias];
    const stageRunId = await this.store.create({
      projectId: req.projectId, ticketId: req.ticketId, subtaskId: req.subtaskId, stage: req.stage, model, attempt, round: req.round ?? 0, reason: req.reason,
    });

    const built = await buildStageContext({
      stageRunId,
      stage: req.stage,
      stack: req.stack,
      claudeMdMode: req.claudeMdMode,
      inputs: req.inputs,
      schema: stageJsonSchema(req.stage),
      config: {
        stage: req.stage, modelAlias: req.modelAlias, modelAliases: req.modelAliases, maxTurns: req.maxTurns, attempt, round: req.round ?? 0,
        jiraTools: req.jira?.tools, mcpServerName: req.jira?.serverName,
      },
      runsDir: path.join(this.config.dataDir, 'runs'),
      guidelinesDir: this.config.guidelinesDir,
      workspacePath: req.workspacePath,
      mcpConfigJson: req.jira?.mcpConfigJson,
    });

    const proxy = `http://proxy:${jira ? 3129 : 3128}`;
    const spec: ContainerSpec = {
      name: `sdlc-run-${stageRunId}`,
      image: this.config.agentImage,
      cmd: ['run-stage'],
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: (await this.creds.resolve()).claude_token,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NO_PROXY: 'localhost,127.0.0.1',
        npm_config_cache: '/npm-cache',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...this.config.agentExtraEnv,
        ...(req.jira?.env ?? {}),
      },
      extraBinds: this.config.agentExtraBinds,
      workspace:
        access === 'none'
          ? undefined
          : {
              path: req.workspacePath as string,
              readOnly: access === 'ro',
              hide: built.hideFiles.length > 0 ? { emptyFile: await this.emptyFile(), names: built.hideFiles } : undefined,
            },
      contextDir: built.runDir,
      memory: this.config.agentMemory,
      cpus: this.config.agentCpus,
      timeoutMs: req.stageTimeoutMin * 60_000,
    };

    const log = this.logs.open(stageRunId, Object.values(req.jira?.env ?? {}));
    const lines: string[] = [];
    let container;
    try {
      container = await this.containers.run(spec, {
        onLine: (line) => {
          lines.push(line);
          log.write(line);
        },
        shouldKill: () => this.store.isKillRequested(stageRunId),
        onStarted: (id) => this.store.markRunning(stageRunId, id),
      });
    } catch (err) {
      const logPath = await log.close();
      const reason = `Container error: ${err instanceof Error ? err.message : String(err)}`;
      await this.store.finish(stageRunId, { status: 'failed', error: reason, logPath });
      // A container error is still a run that ended: it leaves a snapshot too.
      await this.gate?.afterStage({ limit: null, stageRunId, ownTokens: 0 }).catch((e: unknown) => this.logger.warn(`Usage gate failed: ${String(e)}`));
      return { kind: 'failed', reason, stageRunId };
    }
    const logPath = await log.close();

    const parsed = parseStream(lines, req.stage);
    const ownTokens = parsed.usage.inputTokens + parsed.usage.outputTokens + parsed.usage.cacheWriteTokens;
    if (this.gate) {
      await this.gate.afterStage({ limit: parsed.rateLimit, rateLimitError: isRateLimited(parsed), stageRunId, ownTokens }).catch((e: unknown) => this.logger.warn(`Usage gate failed: ${String(e)}`));
    } else if (parsed.rateLimit) {
      await this.store.saveRateLimit(parsed.rateLimit).catch((e: unknown) => this.logger.warn(`saveRateLimit failed: ${String(e)}`));
    }
    const base = { usage: parsed.usage, resultJson: this.resultJson(parsed), logPath };

    if (container.killed) {
      await this.store.finish(stageRunId, { ...base, status: 'killed', error: 'Killed from the dashboard' });
      return { kind: 'killed', stageRunId };
    }
    if (isRateLimited(parsed)) {
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: 'Rate limited' });
      return { kind: 'rate_limited', resetsAt: parsed.rateLimit?.resetsAt ?? null, stageRunId };
    }
    if (parsed.kind === 'turn_limit') {
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: 'Reached the turn limit' });
      return { kind: 'turn_limit', stageRunId };
    }

    const failure = this.failureReason(container, parsed, req);
    if (failure && AUTH_FAILURE.test(lines.join('\n'))) {
      await this.creds.markVerified('claude_token', 'Claude rejected the token').catch(() => undefined);
    }
    if (failure) {
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: failure });
      return { kind: 'failed', reason: failure, stageRunId };
    }
    const envelope = parsed.envelope as StageEnvelope;
    if (envelope.status === 'needs_input') {
      await this.store.finish(stageRunId, { ...base, status: 'needs_input' });
      await this.creds.markVerified('claude_token', null).catch(() => undefined);
      return { kind: 'needs_input', question: envelope.question as string, stageRunId };
    }
    await this.store.finish(stageRunId, { ...base, status: 'succeeded' });
    await this.creds.markVerified('claude_token', null).catch(() => undefined); // a stage that ran proves the token works
    return { kind: 'done', envelope, stageRunId };
  }

  /** Why an attempt failed (BUILD_PLAN 6.8: non-zero exit, timeout, blocked, invalid output), or null if it succeeded. */
  private failureReason(container: { exitCode: number; timedOut: boolean }, parsed: ParsedStream, req: StageRequest): string | null {
    if (container.timedOut) return `Timed out after ${req.stageTimeoutMin} minutes`;
    if (container.exitCode !== 0) return `The stage exited with code ${container.exitCode}${parsed.error ? `: ${parsed.error}` : ''}`;
    if (parsed.kind !== 'ok') return parsed.error ?? 'No valid result';
    const envelope = parsed.envelope as StageEnvelope;
    if (envelope.status === 'blocked') return `The stage reported it is blocked: ${envelope.summary}`;
    const custom = req.validate?.(envelope);
    return custom ? `Validation failed: ${custom}` : null;
  }

  private resultJson(parsed: ParsedStream): unknown {
    if (parsed.envelope) return parsed.envelope;
    return { kind: parsed.kind, error: parsed.error, fieldErrors: parsed.fieldErrors };
  }

  /** An empty file used to hide the repository's CLAUDE.md (mode ours). */
  private async emptyFile(): Promise<string> {
    const file = path.join(this.config.dataDir, 'empty-file');
    await mkdir(this.config.dataDir, { recursive: true });
    // 'wx' creates it only if it is not there yet, in one step (no check-then-write race).
    await writeFile(file, '', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    return file;
  }
}

export type { RateLimit };
