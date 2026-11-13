import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CredentialsService } from '../../credentials/credentials.service';
import { ERROR_POLICY, classifyClaudeError, describeError, nextBackoffMin, stageJsonSchema, type ClaudeMdMode, type ErrorCode, type ModelAlias, type ProjectStack, type StageEnvelope, type StageName } from '@sdlc/shared';
import type { FixReason } from '../../generated/prisma/client';
import { logLine } from '../../common/log-context';
import { USAGE_GATE, type UsageGatePort } from '../usage/usage-gate';
import { WorkerConfig } from '../worker-config';
import { buildStageContext, type StageInputs } from './context-builder';
import type { ContainerSpec } from './container-options';
import { ContainerRunner } from './container-runner';
import { LOG_SINK, type LogSink } from './log-sink';
import { isRateLimited, parseStream, type ParsedStream, type RateLimit } from './result-parser';
import { STAGE_WORKSPACE } from './stage-config';
import { STAGE_RUN_STORE, type StageRunStore } from './stage-run-store';

export interface StageRequest {
  projectId: string;
  ticketId?: string;
  /** For log lines only. */
  ticketKey?: string;
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
  /** Continue this CLI session (the assistant). */
  resumeSession?: string;
  /** Required for every stage that has a workspace (every stage). */
  workspacePath?: string;
  /** Orchestrator validation of a valid envelope (for example "featureKey must be in the index"). Return a message to fail the attempt. */
  validate?: (envelope: StageEnvelope) => string | null;
}

export type StageResult =
  | { kind: 'done'; envelope: StageEnvelope; stageRunId: string; attempts: number }
  | { kind: 'needs_input'; question: string; stageRunId: string; attempts: number }
  /** The recovery policy for `errorCode` is used up (BUILD_PLAN v1 6.3): the ticket is held, or failed when the policy says so. */
  | { kind: 'failed'; reason: string; errorCode?: ErrorCode; stageRunId: string; attempts: number }
  /** Reached the turn limit, also after the retry with more turns. */
  | { kind: 'turn_limit'; errorCode?: 'TURN_LIMIT'; stageRunId: string; attempts: number }
  /** Pause the pipeline until `resetsAt` and re-queue the stage; not counted as an attempt. */
  | { kind: 'rate_limited'; errorCode?: 'CLAUDE_RATE_LIMIT' | 'CLAUDE_USAGE_LIMIT'; resetsAt: Date | null; stageRunId: string; attempts: number }
  /** Claude rejected the credential: pause every Claude stage until it is replaced. The ticket does not fail. */
  | { kind: 'claude_auth'; stageRunId: string; attempts: number }
  /** Killed from the dashboard: the ticket goes on hold (manual). */
  | { kind: 'killed'; errorCode?: 'KILLED'; stageRunId: string; attempts: number };

type AttemptResult =
  | { kind: 'done'; envelope: StageEnvelope; stageRunId: string }
  | { kind: 'needs_input'; question: string; stageRunId: string }
  | { kind: 'failed'; reason: string; errorCode: ErrorCode; stageRunId: string }
  | { kind: 'turn_limit'; errorCode: 'TURN_LIMIT'; stageRunId: string }
  | { kind: 'rate_limited'; errorCode: 'CLAUDE_RATE_LIMIT' | 'CLAUDE_USAGE_LIMIT'; resetsAt: Date | null; stageRunId: string }
  | { kind: 'claude_auth'; stageRunId: string }
  | { kind: 'killed'; errorCode: 'KILLED'; stageRunId: string };

/** Hard stop on automatic attempts, whatever the policies say. */
const MAX_TOTAL_ATTEMPTS = 8;

/** Runs one AI stage end to end (BUILD_PLAN 6.4 and 6.8). */
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

  /** Waits between automatic retries. Tests replace it; `backoffScale` shrinks the minutes of the policy table. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  backoffScale = 1;

  /**
   * Runs the stage, and recovers from failures by the policy table (BUILD_PLAN v1 6.3): each error code has its own
   * number of retries and waits. When the policy is used up the failure is returned for the caller to hold or fail.
   */
  async run(req: StageRequest): Promise<StageResult> {
    const used = new Map<ErrorCode, number>();
    let turnFactor = 1;
    let retryNote: string | undefined;
    let last: AttemptResult | null = null;
    for (let attempt = 1; attempt <= MAX_TOTAL_ATTEMPTS; attempt++) {
      const outcome = await this.runAttempt(req, attempt, { turnFactor, retryNote });
      last = outcome;
      if (outcome.kind !== 'failed' && outcome.kind !== 'turn_limit') return { ...outcome, attempts: attempt } as StageResult;

      const code = outcome.errorCode;
      const n = (used.get(code) ?? 0) + 1;
      used.set(code, n);
      const waitMin = nextBackoffMin(code, n);
      const reason = outcome.kind === 'failed' ? outcome.reason : describeError('TURN_LIMIT', { agent: req.stage });
      this.logger.warn(logLine({ ticket: req.ticketKey, stage: req.stage, run: outcome.stageRunId }, `attempt ${attempt} failed (${code}): ${reason}`));
      if (waitMin === null) return { ...outcome, attempts: attempt } as StageResult;

      const policy = ERROR_POLICY[code].recovery;
      if (policy.kind === 'retry' && policy.turnFactor) turnFactor = policy.turnFactor;
      if (policy.kind === 'retry' && policy.withErrors) retryNote = reason;
      if (waitMin > 0) {
        const ms = waitMin * 60_000 * this.backoffScale;
        await this.store.setRetryAt(outcome.stageRunId, new Date(Date.now() + waitMin * 60_000)).catch(() => undefined);
        await this.sleep(ms);
      }
    }
    return { ...(last as AttemptResult), attempts: MAX_TOTAL_ATTEMPTS } as StageResult;
  }

  private async runAttempt(req: StageRequest, attempt: number, retry: { turnFactor: number; retryNote?: string }): Promise<AttemptResult> {
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
      inputs: retry.retryNote ? { ...req.inputs, retryNote: retry.retryNote } : req.inputs,
      schema: stageJsonSchema(req.stage),
      config: {
        stage: req.stage, modelAlias: req.modelAlias, modelAliases: req.modelAliases, maxTurns: Math.ceil(req.maxTurns * retry.turnFactor), resumeSession: req.resumeSession, attempt, round: req.round ?? 0,
      },
      runsDir: path.join(this.config.dataDir, 'runs'),
      guidelinesDir: this.config.guidelinesDir,
      workspacePath: req.workspacePath,
    });

    const proxy = `http://proxy:3128`;
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
        // The assistant reads the project's bare mirror with git; the mirror is owned by the worker, so git must trust it.
        ...(req.stage === 'assist' ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' } : {}),
        ...this.config.agentExtraEnv,
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

    const log = this.logs.open(stageRunId);
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
      await this.store.finish(stageRunId, { status: 'failed', error: reason, errorCode: 'CONTAINER_ERROR', logPath });
      // A container error is still a run that ended: it leaves a snapshot too.
      await this.gate?.afterStage({ limit: null, stageRunId, ownTokens: 0 }).catch((e: unknown) => this.logger.warn(`Usage gate failed: ${String(e)}`));
      return { kind: 'failed', reason, errorCode: 'CONTAINER_ERROR', stageRunId };
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
      await this.store.finish(stageRunId, { ...base, status: 'killed', error: 'Killed from the dashboard', errorCode: 'KILLED' });
      return { kind: 'killed', errorCode: 'KILLED', stageRunId };
    }
    const text = [parsed.error ?? '', typeof parsed.result?.result === 'string' ? parsed.result.result : '', lines.filter((l) => !l.startsWith('{')).join('\n')].join('\n');
    const status = typeof parsed.result?.api_error_status === 'number' ? parsed.result.api_error_status : null;
    const claudeCode = classifyClaudeError(text, status);

    if (claudeCode === 'CLAUDE_AUTH') {
      const reason = describeError('CLAUDE_AUTH');
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: reason, errorCode: 'CLAUDE_AUTH' });
      await this.creds.markVerified('claude_token', 'Claude rejected the token').catch(() => undefined);
      return { kind: 'claude_auth', stageRunId };
    }
    if (isRateLimited(parsed) || claudeCode === 'CLAUDE_RATE_LIMIT' || claudeCode === 'CLAUDE_USAGE_LIMIT') {
      const errorCode = claudeCode === 'CLAUDE_RATE_LIMIT' ? 'CLAUDE_RATE_LIMIT' : 'CLAUDE_USAGE_LIMIT';
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: describeError(errorCode, { time: parsed.rateLimit?.resetsAt?.toISOString() }), errorCode });
      return { kind: 'rate_limited', errorCode, resetsAt: parsed.rateLimit?.resetsAt ?? null, stageRunId };
    }
    if (parsed.kind === 'turn_limit') {
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: 'Reached the turn limit', errorCode: 'TURN_LIMIT' });
      return { kind: 'turn_limit', errorCode: 'TURN_LIMIT', stageRunId };
    }

    const failure = this.failureReason(container, parsed, req, claudeCode);
    if (failure) {
      await this.store.finish(stageRunId, { ...base, status: 'failed', error: failure.reason, errorCode: failure.code });
      return { kind: 'failed', reason: failure.reason, errorCode: failure.code, stageRunId };
    }
    const envelope = parsed.envelope as StageEnvelope;
    if (envelope.status === 'needs_input') {
      await this.store.finish(stageRunId, { ...base, status: 'needs_input', errorCode: 'NEEDS_INPUT' });
      await this.creds.markVerified('claude_token', null).catch(() => undefined);
      return { kind: 'needs_input', question: envelope.question as string, stageRunId };
    }
    await this.store.finish(stageRunId, { ...base, status: 'succeeded' });
    await this.creds.markVerified('claude_token', null).catch(() => undefined); // a stage that ran proves the token works
    return { kind: 'done', envelope, stageRunId };
  }

  /** Why an attempt failed, with its error code (BUILD_PLAN v1 6.3), or null if it succeeded. */
  private failureReason(container: { exitCode: number; timedOut: boolean }, parsed: ParsedStream, req: StageRequest, claudeCode: ErrorCode | null): { reason: string; code: ErrorCode } | null {
    if (container.timedOut) return { reason: describeError('TIMEOUT', { stage: req.stage, limit: `${req.stageTimeoutMin} minutes` }), code: 'TIMEOUT' };
    if (claudeCode === 'CLAUDE_CONTEXT_TOO_LONG') return { reason: describeError('CLAUDE_CONTEXT_TOO_LONG', { stage: req.stage, sizes: parsed.error ?? 'see the run log' }), code: claudeCode };
    if (claudeCode === 'CLAUDE_API_ERROR') return { reason: describeError('CLAUDE_API_ERROR', { detail: (parsed.error ?? 'no detail').slice(0, 120), n: '', time: '' }).replace(/ Retry\s*\/3 at\.?$/, ''), code: claudeCode };
    if (container.exitCode !== 0) return { reason: `The stage exited with code ${container.exitCode}${parsed.error ? `: ${parsed.error}` : ''}`, code: 'CONTAINER_ERROR' };
    if (parsed.kind === 'error') return { reason: parsed.error ?? 'The CLI reported an error', code: 'CLAUDE_API_ERROR' };
    if (parsed.kind !== 'ok') return { reason: parsed.error ?? 'No valid result', code: 'INVALID_OUTPUT' };
    const envelope = parsed.envelope as StageEnvelope;
    if (envelope.status === 'blocked') return { reason: `The stage reported it is blocked: ${envelope.summary}`, code: 'BLOCKED' };
    const custom = req.validate?.(envelope);
    return custom ? { reason: `Validation failed: ${custom}`, code: 'INVALID_OUTPUT' } : null;
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
