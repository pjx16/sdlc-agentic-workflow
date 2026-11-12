import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkerConfig } from '../worker-config';
import { OrphanCleanup } from './orphan-cleanup';

const KEEP = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
let data: string;

beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), 'sdlc-orphans-'));
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

const touch = (rel: string) => {
  mkdirSync(path.join(data, rel), { recursive: true });
  writeFileSync(path.join(data, rel, 'f'), 'x');
};

describe('OrphanCleanup', () => {
  it('removes the workspaces and mirror of deleted projects only, and ignores anything not named like a project id', async () => {
    touch(`workspaces/${KEEP}/BILL-1`);
    touch(`workspaces/${GONE}/BILL-1`);
    touch(`mirrors/${KEEP}.git`);
    touch(`mirrors/${GONE}.git`);
    touch('workspaces/not-a-project-id');
    const prisma = { project: { findMany: async () => [{ id: KEEP }] } };
    const cleanup = new OrphanCleanup(prisma as never, new WorkerConfig({ DATA_DIR: data, DATABASE_URL: 'x' } as NodeJS.ProcessEnv));

    expect(await cleanup.run()).toBe(2);
    expect(existsSync(path.join(data, 'workspaces', KEEP))).toBe(true);
    expect(existsSync(path.join(data, 'mirrors', `${KEEP}.git`))).toBe(true);
    expect(existsSync(path.join(data, 'workspaces', GONE))).toBe(false);
    expect(existsSync(path.join(data, 'mirrors', `${GONE}.git`))).toBe(false);
    expect(existsSync(path.join(data, 'workspaces', 'not-a-project-id'))).toBe(true);
    expect(await cleanup.run()).toBe(0);
  });

  it('does nothing when the folders do not exist yet', async () => {
    const cleanup = new OrphanCleanup({ project: { findMany: async () => [] } } as never, new WorkerConfig({ DATA_DIR: data, DATABASE_URL: 'x' } as NodeJS.ProcessEnv));
    expect(await cleanup.run()).toBe(0);
  });
});
