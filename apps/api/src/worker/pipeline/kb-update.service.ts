import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, type StageEnvelope } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CommitGuardError, squashAgentCommits } from '../git/commit-guard';
import { PushRejectedError } from '../git/commit';
import { GitRunner } from '../git/git-runner';
import { makeWritableForAgent } from '../git/workspace';
import { WorkspaceService } from '../git/workspace.service';
import { revertOutsideDir } from '../kb/kb-guard';
import { lookup, readIndex, safeDocPath, upsertEntry } from '../kb/kb-index';
import { computeDiff } from '../review/diff';
import { WorkerConfig } from '../worker-config';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepOutcome } from './step-handler';

interface KbUpdateData {
  featureKey: string;
  docPath: string;
  changed: boolean;
}

export type KbUpdateResult = { kind: 'updated' | 'unchanged' | 'skipped'; note: string } | { kind: 'outcome'; outcome: StepOutcome };

/**
 * The `kbUpdate` stage (F11): the ticket's diff and the feature doc go in, the doc is updated in place, only `kbDir` may change.
 * A changed doc gets its index entry refreshed and is committed as `docs(<KEY>): update <featureKey> knowledge base`.
 * A ticket with no KB doc, or a change that does not affect the doc, is not an error.
 */
@Injectable()
export class KbUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitRunner,
    private readonly config: WorkerConfig,
  ) {}

  async run(ticket: Ticket): Promise<KbUpdateResult> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const ws = this.launcher.workspaceOf(ticket);
    const kbDir = project.kbDir;
    const maxLines = settings.limits.kbDocMaxLines;

    const { match } = await lookup(ws, kbDir, ticket.featureKey);
    if (!match) return { kind: 'skipped', note: 'the ticket has no KB doc' };

    const diff = await computeDiff(this.git, ws, { from: `origin/${project.baseBranch}`, mergeBase: true });
    if (diff.patch.trim() === '') return { kind: 'skipped', note: 'the branch has no changes against the base branch' };

    await makeWritableForAgent(ws);
    const preHead = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    const tooLarge = diff.lines > settings.limits.reviewMaxDiffLines;
    const result = await this.launcher.launch(
      ticket,
      'kbUpdate',
      {
        ticket: { key: ticket.key, title: ticket.title, body: ticket.body },
        kbDir,
        kbDocMaxLines: maxLines,
        existingDoc: match.content,
        docTemplate: await this.template(),
        ...(tooLarge ? { diffStat: diff.stat, diffRange: `origin/${project.baseBranch}...HEAD`, diffLines: diff.lines } : { diff: diff.patch }),
      },
      { workspacePath: ws, validate: (e) => this.validate(e, { ws, kbDir, featureKey: match.entry.key, maxLines }) },
    );
    if (result.kind !== 'done') return { kind: 'outcome', outcome: await this.outcomes.forResult(ticket.id, 'kbUpdate', result) };

    const squashed = await squashAgentCommits(this.git, ws, preHead);
    if (squashed > 0) await this.event(ticket.id, `Warning: the agent made ${squashed} commit(s) of its own; they were squashed back`);
    const reverted = await revertOutsideDir(this.git, ws, kbDir);
    if (reverted.length > 0) await this.event(ticket.id, `Warning: kbUpdate changed ${reverted.length} file(s) outside ${kbDir}; reverted: ${reverted.join(', ')}`);

    // Only the feature's own doc may change; the index entry is the orchestrator's.
    const docRel = path.relative(kbDir, match.relPath);
    const status = (await this.git.out(['status', '--porcelain=v1', '--', kbDir], { cwd: ws })).trim();
    if (status === '') return { kind: 'unchanged', note: 'the change does not affect the KB doc' };

    const head = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    const { index } = await readIndex(ws, kbDir);
    await upsertEntry(ws, kbDir, { ...match.entry, doc: index.features.find((f) => f.key === match.entry.key)?.doc ?? docRel, builtFromCommit: head, updatedAt: new Date().toISOString() });
    try {
      await this.workspaces.commit(ticket.id, `docs(${ticket.key}): update ${match.entry.key} knowledge base`, { paths: [kbDir] });
      await this.workspaces.push(ticket.id);
    } catch (err) {
      if (err instanceof CommitGuardError || err instanceof PushRejectedError) return { kind: 'outcome', outcome: { kind: 'hold', reason: 'needs_help', note: err.message.slice(0, 500), stageRunId: result.stageRunId } };
      throw err;
    }
    return { kind: 'updated', note: `${match.entry.key} knowledge base updated` };
  }

  private validate(envelope: StageEnvelope, ctx: { ws: string; kbDir: string; featureKey: string; maxLines: number }): string | null {
    if (envelope.status !== 'done') return null;
    const d = envelope.data as KbUpdateData;
    if (d.featureKey !== ctx.featureKey) return `featureKey must stay "${ctx.featureKey}", not "${d.featureKey}"`;
    const full = safeDocPath(ctx.ws, ctx.kbDir, path.relative(ctx.kbDir, d.docPath));
    if (!full || !existsSync(full)) return `docPath "${d.docPath}" must be the existing doc inside ${ctx.kbDir}`;
    const lines = readFileSync(full, 'utf8').split('\n').length;
    return lines > ctx.maxLines ? `the doc has ${lines} lines, more than the limit of ${ctx.maxLines}` : null;
  }

  private async template(): Promise<string> {
    const file = path.join(this.config.guidelinesDir, 'kb-doc-template.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  private event(ticketId: string, message: string) {
    return this.prisma.event.create({ data: { ticketId, type: 'git', message: message.slice(0, 500) } });
  }
}
