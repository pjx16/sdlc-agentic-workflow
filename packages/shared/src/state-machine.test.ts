import { describe, expect, it } from 'vitest';
import { TICKET_STATUSES, type TicketStatus } from './enums';
import { ACTIONABLE_STATUSES, HOLDABLE, approvalTarget, checkTransition } from './state-machine';

/** BUILD_PLAN 6.6 rows 1 to 15, written out independently of the implementation. */
const ROWS: [TicketStatus, TicketStatus][] = [
  ['NEW', 'KB'], ['KB', 'PLANNING'], ['PLANNING', 'AWAITING_PLAN_APPROVAL'], ['PLANNING', 'BREAKDOWN'],
  ['AWAITING_PLAN_APPROVAL', 'BREAKDOWN'], ['AWAITING_PLAN_APPROVAL', 'PLANNING'],
  ['BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL'], ['BREAKDOWN', 'IN_PROGRESS'],
  ['AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS'], ['AWAITING_BREAKDOWN_APPROVAL', 'BREAKDOWN'],
  ['IN_PROGRESS', 'REVIEW'], ['IN_PROGRESS', 'KB_UPDATE'], ['REVIEW', 'KB_UPDATE'], ['REVIEW', 'AWAITING_CI'],
  ['KB_UPDATE', 'AWAITING_CI'], ['AWAITING_CI', 'IN_HUMAN_REVIEW'], ['IN_HUMAN_REVIEW', 'DONE'],
];
const key = (a: string, b: string) => `${a}>${b}`;
const ROW_KEYS = new Set(ROWS.map(([a, b]) => key(a, b)));

describe('state machine (BUILD_PLAN 6.6)', () => {
  it('allows every row of the table', () => {
    for (const [from, to] of ROWS) expect(checkTransition(from, to), key(from, to)).toEqual({ ok: true });
  });

  it('rejects every other pair of statuses', () => {
    const rejected: string[] = [];
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        if (ROW_KEYS.has(key(from, to))) continue;
        if (to === 'ON_HOLD' || to === 'FAILED') continue; // rules 16 and 18, tested below
        // With no holdFromStatus nothing can resume, so every remaining pair must be rejected.
        const verdict = checkTransition(from, to);
        expect(verdict.ok, key(from, to)).toBe(false);
        rejected.push(key(from, to));
      }
    }
    expect(rejected.length).toBeGreaterThan(100);
  });

  it('never allows a ticket to move to its own state', () => {
    for (const s of TICKET_STATUSES) expect(checkTransition(s, s).ok).toBe(false);
  });

  it('never leaves DONE', () => {
    for (const to of TICKET_STATUSES) expect(checkTransition('DONE', to, { holdFromStatus: 'NEW' }).ok).toBe(false);
  });

  it('row 16: any state except DONE and FAILED can be put on hold', () => {
    for (const from of TICKET_STATUSES) {
      const allowed = from !== 'DONE' && from !== 'FAILED' && from !== 'ON_HOLD';
      expect(checkTransition(from, 'ON_HOLD').ok, from).toBe(allowed);
      expect(HOLDABLE.has(from)).toBe(allowed);
    }
  });

  it('row 17: ON_HOLD returns only to holdFromStatus', () => {
    expect(checkTransition('ON_HOLD', 'PLANNING', { holdFromStatus: 'PLANNING' })).toEqual({ ok: true });
    expect(checkTransition('ON_HOLD', 'KB', { holdFromStatus: 'PLANNING' }).ok).toBe(false);
    expect(checkTransition('ON_HOLD', 'PLANNING').ok).toBe(false);
    expect(checkTransition('ON_HOLD', 'PLANNING', { holdFromStatus: null }).ok).toBe(false);
  });

  it('row 18: any state except DONE can fail; FAILED returns only to the state it failed in', () => {
    for (const from of TICKET_STATUSES) expect(checkTransition(from, 'FAILED').ok, from).toBe(from !== 'DONE' && from !== 'FAILED');
    expect(checkTransition('FAILED', 'IN_PROGRESS', { holdFromStatus: 'IN_PROGRESS' })).toEqual({ ok: true });
    expect(checkTransition('FAILED', 'NEW', { holdFromStatus: 'IN_PROGRESS' }).ok).toBe(false);
    expect(checkTransition('ON_HOLD', 'FAILED')).toEqual({ ok: true });
  });

  it('a held ticket cannot skip ahead', () => {
    expect(checkTransition('ON_HOLD', 'DONE', { holdFromStatus: 'IN_HUMAN_REVIEW' }).ok).toBe(false);
  });

  it('explains why a transition was rejected', () => {
    expect(checkTransition('NEW', 'DONE')).toEqual({ ok: false, reason: 'Transition NEW -> DONE is not allowed' });
  });

  it('the worker only picks up the actionable states', () => {
    expect([...ACTIONABLE_STATUSES]).toEqual(['NEW', 'KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE']);
  });
});

describe('approvalTarget (F15 inbound approval)', () => {
  const approvals = { plan: 'Plan Approved', breakdown: 'Ready for Dev' };
  it('approves a plan or a breakdown when the Jira status matches, case-insensitively', () => {
    expect(approvalTarget('AWAITING_PLAN_APPROVAL', 'plan approved', approvals)).toBe('BREAKDOWN');
    expect(approvalTarget('AWAITING_BREAKDOWN_APPROVAL', ' Ready for Dev ', approvals)).toBe('IN_PROGRESS');
  });
  it('ignores any other Jira status, and the wrong gate', () => {
    expect(approvalTarget('AWAITING_PLAN_APPROVAL', 'In Progress', approvals)).toBeNull();
    expect(approvalTarget('AWAITING_PLAN_APPROVAL', 'Ready for Dev', approvals)).toBeNull();
    expect(approvalTarget('AWAITING_BREAKDOWN_APPROVAL', 'Plan Approved', approvals)).toBeNull();
  });
  it('ignores tickets that are not awaiting approval', () => {
    for (const s of TICKET_STATUSES.filter((x) => !x.startsWith('AWAITING_P') && !x.startsWith('AWAITING_B'))) expect(approvalTarget(s, 'Plan Approved', approvals), s).toBeNull();
  });
  it('does nothing when no approval status is configured', () => {
    expect(approvalTarget('AWAITING_PLAN_APPROVAL', 'Plan Approved', {})).toBeNull();
    expect(approvalTarget('AWAITING_PLAN_APPROVAL', '', { plan: '' })).toBeNull();
  });
});
