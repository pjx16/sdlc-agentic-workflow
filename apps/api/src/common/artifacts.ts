import type { Prisma, StageArtifact } from '../generated/prisma/client';

/** Every version of each stage's output (BUILD_PLAN v1 6.8). Outputs are versioned, never overwritten. */
export const ARTIFACT_STAGES = ['plan', 'breakdown', 'review', 'kb'] as const;
export type ArtifactStage = (typeof ARTIFACT_STAGES)[number];

/** The slice of the Prisma client these helpers need (works with the client and with a transaction). */
interface ArtifactDb {
  stageArtifact: {
    findFirst(args: { where: Prisma.StageArtifactWhereInput; orderBy?: Prisma.StageArtifactOrderByWithRelationInput }): Promise<StageArtifact | null>;
    findMany(args: { where: Prisma.StageArtifactWhereInput; orderBy?: Prisma.StageArtifactOrderByWithRelationInput | Prisma.StageArtifactOrderByWithRelationInput[] }): Promise<StageArtifact[]>;
    create(args: { data: Prisma.StageArtifactUncheckedCreateInput }): Promise<StageArtifact>;
  };
}

/**
 * Stores a new version of a stage's output. `review` has one artifact per round, so its versions are rounds. Two writers at once may pick
 * the same number: the unique index refuses the second, which tries again with the next one.
 */
export async function writeArtifact(db: ArtifactDb, ticketId: string, stage: ArtifactStage, data: unknown, stageRunId?: string | null): Promise<StageArtifact> {
  for (let attempt = 0; ; attempt++) {
    const last = await db.stageArtifact.findFirst({ where: { ticketId, stage }, orderBy: { version: 'desc' } });
    try {
      return await db.stageArtifact.create({ data: { ticketId, stage, version: (last?.version ?? 0) + 1, data: data as Prisma.InputJsonValue, stageRunId: stageRunId ?? null } });
    } catch (err) {
      if (attempt >= 3 || (err as { code?: string }).code !== 'P2002') throw err;
    }
  }
}

/** The current output of a stage: the latest version that is not stale. Null when the stage has no output yet, or it was superseded. */
export const currentArtifact = (db: ArtifactDb, ticketId: string, stage: ArtifactStage): Promise<StageArtifact | null> =>
  db.stageArtifact.findFirst({ where: { ticketId, stage, supersededAt: null }, orderBy: { version: 'desc' } });

/** The newest version of a stage's output even if it is stale: what a rerun shows the agent as "previous attempt (stale)". */
export const latestArtifact = (db: ArtifactDb, ticketId: string, stage: ArtifactStage): Promise<StageArtifact | null> =>
  db.stageArtifact.findFirst({ where: { ticketId, stage }, orderBy: { version: 'desc' } });

/** All versions of a ticket's outputs, oldest first, stale ones included (the dashboard shows them side by side). */
export const allArtifacts = (db: ArtifactDb, ticketId: string): Promise<StageArtifact[]> =>
  db.stageArtifact.findMany({ where: { ticketId }, orderBy: [{ stage: 'asc' }, { version: 'asc' }] });
