import { describe, expect, it } from 'vitest';
import { ago, describeActivity, inFuture } from './activity';
import type { IntakeStatusView, SystemView, WorkerStatusView } from './types';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const intake = (over: Partial<IntakeStatusView> = {}): IntakeStatusView => ({ mode: 'rest', at: at(30), projects: 1, waiting: 0, created: 0, seen: 0, error: null, skipped: null, ...over });
const worker = (over: Partial<WorkerStatusView> = {}): WorkerStatusView => ({ online: true, state: 'idle', phase: 'idle', phaseDetail: null, phaseSince: at(3), startedAt: at(900), pid: 1, version: '1.0.0', restartingRepeatedly: false, heartbeatAt: at(3), tickOutcome: 'idle', tickDetail: null, intake: [], ...over });
const system = (over: { worker?: WorkerStatusView | null; paused?: boolean; intakePaused?: boolean; running?: boolean; reason?: string | null } = {}): SystemView =>
  ({
    settings: { pipelinePaused: over.paused ?? false, pausedReason: over.reason ?? null, intakePaused: over.intakePaused ?? false, pollIntervalSec: 120 },
    worker: over.worker === undefined ? worker() : over.worker,
    runningStage: over.running ? { id: 'r1', stage: 'plan', model: 'opus', projectId: 'p', ticketId: 't', startedAt: at(10) } : null,
    recentEvents: [],
    usage: null,
  }) as unknown as SystemView;
const line = (s: SystemView | null, key: string) => describeActivity(s, NOW).find((l) => l.key === key);

describe('ago / inFuture', () => {
  it('formats elapsed and upcoming time', () => {
    expect(ago(at(5), NOW)).toBe('5s ago');
    expect(ago(at(180), NOW)).toBe('3 min ago');
    expect(ago(at(7200), NOW)).toBe('2 h ago');
    expect(ago(null, NOW)).toBe('never');
    expect(inFuture(40_000)).toBe('in 40s');
    expect(inFuture(150_000)).toBe('in 3 min');
    expect(inFuture(-5)).toBe('due now');
  });
});

describe('describeActivity: the worker', () => {
  it('says so when the worker has never reported, and tells you how to start it', () => {
    const l = describeActivity(system({ worker: null }), NOW);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ key: 'worker', tone: 'amber' });
    expect(l[0]?.text).toContain('npm run up:dev');
  });
  it('says offline (red) when the heartbeat is stale, and shows nothing else', () => {
    const l = describeActivity(system({ worker: worker({ online: false, state: 'offline', heartbeatAt: at(600) }) }), NOW);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tone: 'red' });
    expect(l[0]?.text).toContain('Offline: last seen 10 min ago');
  });
  it('shows all four states: idle, busy with phase and time, stalled, offline', () => {
    expect(line(system(), 'worker')).toMatchObject({ tone: 'green', text: 'Online, idle (checked 3s ago).' });
    const busy = worker({ state: 'busy', phase: 'stage', phaseDetail: 'implement on SDA-12', phaseSince: at(185) });
    expect(line(system({ worker: busy }), 'worker')).toMatchObject({ tone: 'green', text: 'Online, busy (stage: implement on SDA-12) for 3 min.' });
    const stalled = worker({ state: 'stalled', phase: 'stage', phaseDetail: 'implement on SDA-12', phaseSince: at(3 * 3600) });
    expect(line(system({ worker: stalled }), 'worker')).toMatchObject({ tone: 'amber' });
    expect(line(system({ worker: stalled }), 'worker')?.text).toContain('Stalled');
    expect(line(system({ worker: worker({ state: 'offline', online: false }) }), 'worker')).toMatchObject({ tone: 'red' });
  });
  it('shows a banner line when the worker keeps restarting', () => {
    expect(line(system({ worker: worker({ restartingRepeatedly: true }) }), 'worker')).toMatchObject({ tone: 'red', text: expect.stringContaining('restarting repeatedly') });
  });
});

describe('describeActivity: the pipeline', () => {
  it('idle, running, paused, blocked by setup, working on a ticket, and a failed iteration', () => {
    expect(line(system(), 'pipeline')).toMatchObject({ tone: 'grey', text: expect.stringContaining('Idle') });
    expect(line(system({ running: true }), 'pipeline')).toMatchObject({ tone: 'green', text: 'Running plan with opus for 10s.', link: { href: '/runs/r1' } });
    expect(line(system({ paused: true, reason: 'manual' }), 'pipeline')).toMatchObject({ tone: 'amber', text: 'Paused. Paused by you.' });
    const blocked = line(system({ worker: worker({ tickOutcome: 'not_configured', tickDetail: 'claude_token, github_token' }) }), 'pipeline');
    expect(blocked).toMatchObject({ tone: 'amber', link: { href: '/setup/connections' } });
    expect(blocked?.text).toContain('claude_token, github_token');
    expect(line(system({ worker: worker({ tickOutcome: 'stepped', tickDetail: 'SDA-1 (PLANNING)' }) }), 'pipeline')?.text).toBe('Working on SDA-1 (PLANNING).');
    expect(line(system({ worker: worker({ tickDetail: 'Iteration failed: boom' }) }), 'pipeline')).toMatchObject({ tone: 'red', text: 'Iteration failed: boom' });
  });
});

describe('describeActivity: Jira intake', () => {
  it('has not polled yet', () => {
    expect(line(system(), 'intake')?.text).toContain('Has not polled yet');
  });
  it('is paused by you, and says pasted tickets still work', () => {
    expect(line(system({ intakePaused: true }), 'intake')).toMatchObject({ tone: 'amber', text: expect.stringContaining('Pasted tickets still work') });
  });
  it('REST: last poll, what it found and when the next one is', () => {
    const l = line(system({ worker: worker({ intake: [intake({ seen: 3, created: 1 })] }) }), 'intake-rest');
    expect(l).toMatchObject({ tone: 'green' });
    expect(l?.text).toBe('Polled 30s ago: found 3 tickets, 1 new. Next poll in 90s.');
  });
  it('MCP: shows the cost warning instead of a countdown', () => {
    const l = line(system({ worker: worker({ intake: [intake({ mode: 'mcp', seen: 0 })] }) }), 'intake-mcp');
    expect(l?.text).toContain('found 0 tickets');
    expect(l?.text).toContain('runs Claude');
  });
  it('reminds that the default query needs the label when a poll found nothing, but not when it found tickets', () => {
    const none = line(system({ worker: worker({ intake: [intake({ seen: 0 })] }) }), 'intake-rest');
    expect(none?.text).toContain('found 0 tickets (the default query only picks up issues labelled "sdlc-agent")');
    expect(line(system({ worker: worker({ intake: [intake({ seen: 2, created: 1 })] }) }), 'intake-rest')?.text).not.toContain('labelled');
  });
  it('no project uses the mode, or the projects are waiting for their mirror', () => {
    expect(line(system({ worker: worker({ intake: [intake({ projects: 0 })] }) }), 'intake-rest')).toMatchObject({ tone: 'grey', text: 'No project uses REST intake.' });
    const waiting = line(system({ worker: worker({ intake: [intake({ mode: 'mcp', projects: 0, waiting: 1 })] }) }), 'intake-mcp');
    expect(waiting).toMatchObject({ tone: 'amber' });
    expect(waiting?.text).toContain('mirror is not Ready');
  });
  it('shows an error in red, and a backoff', () => {
    expect(line(system({ worker: worker({ intake: [intake({ error: 'Jira rejected the credentials' })] }) }), 'intake-rest')).toMatchObject({ tone: 'red', text: expect.stringContaining('Jira rejected the credentials') });
    expect(line(system({ worker: worker({ intake: [intake({ skipped: 'backoff' })] }) }), 'intake-rest')?.text).toContain('unreachable');
  });
  it('hides a mode nobody uses when another mode is active (a REST poll must not mask an MCP poll)', () => {
    const l = describeActivity(system({ worker: worker({ intake: [intake({ mode: 'mcp', seen: 2, created: 2 }), intake({ mode: 'rest', projects: 0 })] }) }), NOW);
    expect(l.map((x) => x.key)).toEqual(['worker', 'pipeline', 'intake-mcp']);
  });
});
