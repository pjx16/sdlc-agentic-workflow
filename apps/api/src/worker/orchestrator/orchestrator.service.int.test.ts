import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StageEnvelope } from '@sdlc/shared';
import { StepsHarness } from '../../testing/steps-harness';
import { OrchestratorService } from './orchestrator.service';

const answer = (kind: string, to: string, reason = 'Only a test changed.'): StageEnvelope => ({ status: 'done', summary: 'chose', data: { move: { kind, to }, reason } as never });

describe('the orchestrator (BUILD_PLAN v1 6.11)', () => {
  let h: StepsHarness;
  let orchestrator: OrchestratorService;
  const outcome = { kind: 'transition', to: 'KB_UPDATE', reason: 'Review done' } as const;

  beforeAll(async () => {
    h = await StepsHarness.create();
    orchestrator = new OrchestratorService(h.prisma, h.launcher);
  }, 180_000);
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.agent.requests = [];
    h.agent.override = null;
    await h.setProject({ settings: {} });
  });

  it('with several legal moves it calls the agent, thinks, and may take the other move; the decision is stored and on the timeline', async () => {
    const t = await h.ticket({ status: 'REVIEW' });
    h.agent.scripts.orchestrate = () => answer('advance', 'AWAITING_CI');
    const res = await orchestrator.review(t, outcome);
    expect(res).toMatchObject({ kind: 'transition', to: 'AWAITING_CI' });
    expect(h.agent.requests.map((r) => r.stage)).toEqual(['orchestrate']);
    expect(h.agent.requests[0]?.thinkingTokens).toBeGreaterThan(0);
    expect(h.agent.requests[0]?.inputs.orchestrate?.moves).toEqual([
      expect.objectContaining({ to: 'KB_UPDATE', isDefault: true }),
      expect.objectContaining({ to: 'AWAITING_CI', isDefault: false }),
    ]);
    expect(await h.prisma.orchestratorDecision.findMany({ where: { ticketId: t.id } })).toMatchObject([{ point: 'kb_update', chosen: 'advance AWAITING_CI', fallbackUsed: false, reason: 'Only a test changed.' }]);
    expect(await h.prisma.event.count({ where: { ticketId: t.id, source: 'orchestrator', level: 'info' } })).toBe(1);
  });

  it('choosing the default leaves the outcome alone', async () => {
    const t = await h.ticket({ status: 'REVIEW' });
    h.agent.scripts.orchestrate = () => answer('advance', 'KB_UPDATE', 'Behaviour changed.');
    expect(await orchestrator.review(t, outcome)).toBe(outcome);
  });

  it('an answer that is not a legal move is replaced by the default and logged as a warning', async () => {
    const t = await h.ticket({ status: 'REVIEW' });
    h.agent.scripts.orchestrate = () => answer('advance', 'DONE');
    expect(await orchestrator.review(t, outcome)).toBe(outcome);
    expect(await h.prisma.orchestratorDecision.findMany({ where: { ticketId: t.id } })).toMatchObject([{ fallbackUsed: true, chosen: 'advance KB_UPDATE' }]);
    expect(await h.prisma.event.count({ where: { ticketId: t.id, source: 'orchestrator', level: 'warn' } })).toBe(1);
  });

  it('a failed call also falls back to the default move', async () => {
    const t = await h.ticket({ status: 'REVIEW' });
    h.agent.scripts.orchestrate = () => ({ status: 'blocked', summary: 'cannot' }) as StageEnvelope;
    expect(await orchestrator.review(t, outcome)).toBe(outcome);
    expect((await h.prisma.orchestratorDecision.findFirstOrThrow({ where: { ticketId: t.id } })).fallbackUsed).toBe(true);
  });

  it('with one legal move (the KB update is switched off) code takes it and no agent is called', async () => {
    await h.setProject({ settings: { stages: { kbUpdate: { enabled: false } } } });
    const t = await h.ticket({ status: 'REVIEW' });
    const res = await orchestrator.review(t, { kind: 'transition', to: 'AWAITING_CI', reason: 'x' });
    expect(res).toMatchObject({ to: 'AWAITING_CI' });
    expect(h.agent.requests).toEqual([]);
    expect(await h.prisma.orchestratorDecision.count({ where: { ticketId: t.id } })).toBe(0);
  });

  it('a state with no decision point, and a hold, never call the agent', async () => {
    const t = await h.ticket({ status: 'KB' });
    expect(await orchestrator.review(t, { kind: 'transition', to: 'PLANNING', reason: 'x' })).toMatchObject({ to: 'PLANNING' });
    const r = await h.ticket({ status: 'REVIEW' });
    const hold = { kind: 'hold', reason: 'needs_help', note: 'n' } as const;
    expect(await orchestrator.review(r, hold)).toBe(hold);
    expect(h.agent.requests).toEqual([]);
  });

  it('with the orchestrate stage switched off the default move is used', async () => {
    await h.setProject({ settings: { stages: { orchestrate: { enabled: false } } } });
    const t = await h.ticket({ status: 'REVIEW' });
    expect(await orchestrator.review(t, outcome)).toBe(outcome);
    expect(h.agent.requests).toEqual([]);
  });
});
