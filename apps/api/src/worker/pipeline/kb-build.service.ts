import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProjectSettingsSchema, type StageEnvelope } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';
import { writeArtifact } from '../../common/artifacts';
import { PrismaService } from '../../prisma/prisma.service';
import { readTextNoFollowSync } from '../fs/safe-fs';
import { squashAgentCommits } from '../git/commit-guard';
import { GitRunner } from '../git/git-runner';
import { WorkspaceService } from '../git/workspace.service';
import { FEATURE_KEY, readIndex, safeDocPath, upsertEntry } from '../kb/kb-index';
import { revertDir, revertOutsideDir } from '../kb/kb-guard';
import type { KbBuilder } from './kb.handler';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';
import type { StepOutcome } from './step-handler';

interface KbBuildData {
  featureKey: string;
  isNew: boolean;
  docPath: string;
  globs: string[];
}

const titleOf = (key: string) => key.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The `kbBuild` stage (F6): choose an existing KB key or write a new doc, keep only changes under `kbDir`,
 * update the index, and commit `docs(<KEY>): add <featureKey> knowledge base doc` on the ticket branch.
 */
@Injectable()
export class KbBuildService implements KbBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly launcher: StageLauncher,
    private readonly outcomes: StageOutcomes,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitRunner,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
    const settings = ProjectSettingsSchema.parse(project.settings);
    const ws = this.launcher.workspaceOf(ticket);
    const kbDir = project.kbDir;
    const maxLines = settings.limits.kbDocMaxLines;
    const preHead = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
    const { index } = await readIndex(ws, kbDir);
    const keys = index.features.map((f) => f.key);

    const result = await this.launcher.launch(
      ticket,
      'kbBuild',
      { ticket: { key: ticket.key, title: ticket.title, body: ticket.body }, indexKeys: keys, kbDir, kbDocMaxLines: maxLines },
      { workspacePath: ws, validate: (envelope) => this.validate(envelope, { ws, kbDir, keys, maxLines }) },
    );
    if (result.kind !== 'done') return this.outcomes.forResult(ticket.id, 'kbBuild', result);

    const squashed = await squashAgentCommits(this.git, ws, preHead);
    if (squashed > 0) await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: the agent made ${squashed} commit(s) of its own; they were squashed back` } });
    const data = result.envelope.data as KbBuildData;
    await this.keepOnlyKbChanges(ticket, ws, kbDir, data.isNew);

    if (data.isNew) {
      const head = await this.git.out(['rev-parse', 'HEAD'], { cwd: ws });
      await upsertEntry(ws, kbDir, {
        key: data.featureKey,
        title: titleOf(data.featureKey),
        doc: path.relative(kbDir, data.docPath),
        globs: data.globs,
        builtFromCommit: head,
        updatedAt: new Date().toISOString(),
      });
      await this.workspaces.commit(ticket.id, `docs(${ticket.key}): add ${data.featureKey} knowledge base doc`, { paths: [kbDir] });
    }
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { featureKey: data.featureKey } });
    await writeArtifact(this.prisma, ticket.id, 'kb', { featureKey: data.featureKey, docPath: data.docPath, isNew: data.isNew }, result.stageRunId).catch(() => undefined);
    return { kind: 'transition', to: 'PLANNING', reason: `KB doc ${data.isNew ? 'built' : 'selected'}: ${data.featureKey}`, stageRunId: result.stageRunId };
  }

  /** The orchestrator's checks on a valid envelope. A message fails the attempt (BUILD_PLAN 6.8). */
  private validate(envelope: StageEnvelope, ctx: { ws: string; kbDir: string; keys: string[]; maxLines: number }): string | null {
    if (envelope.status !== 'done') return null;
    const d = envelope.data as KbBuildData;
    if (!FEATURE_KEY.test(d.featureKey)) return `featureKey "${d.featureKey}" is not a valid key (lower-case letters, digits, dot, dash, underscore)`;
    if (!d.isNew) {
      return ctx.keys.includes(d.featureKey) ? null : `featureKey "${d.featureKey}" is not in the KB index, so isNew must be true`;
    }
    if (ctx.keys.includes(d.featureKey)) return `featureKey "${d.featureKey}" already exists in the KB index, so isNew must be false`;
    const prefix = `${ctx.kbDir.replace(/\/+$/, '')}/`;
    const inside = d.docPath.startsWith(prefix) ? d.docPath.slice(prefix.length) : null;
    const full = inside ? safeDocPath(ctx.ws, ctx.kbDir, inside) : null;
    if (!full) return `docPath "${d.docPath}" must be a .md file inside ${ctx.kbDir}`;
    const text = readTextNoFollowSync(ctx.ws, path.relative(ctx.ws, full)); // never follows a symlink the agent left (S3)
    if (text === null) return `the doc ${d.docPath} was not written`;
    const lines = text.split('\n').length;
    if (lines > ctx.maxLines) return `the doc has ${lines} lines, more than the limit of ${ctx.maxLines}`;
    return null;
  }

  private async keepOnlyKbChanges(ticket: Ticket, ws: string, kbDir: string, isNew: boolean): Promise<void> {
    const reverted = await revertOutsideDir(this.git, ws, kbDir);
    if (reverted.length > 0) {
      await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: kbBuild changed ${reverted.length} file(s) outside ${kbDir}; reverted: ${reverted.join(', ')}`.slice(0, 500) } });
    }
    if (!isNew) {
      // Choosing an existing doc must not rewrite it.
      const undone = await revertDir(this.git, ws, kbDir);
      if (undone.length > 0) await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Warning: kbBuild changed the existing KB docs (${undone.join(', ')}); reverted`.slice(0, 500) } });
    }
  }
}
