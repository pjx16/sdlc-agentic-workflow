import { describe, expect, it } from 'vitest';
import { TICKET_STATUSES, type TicketStatus } from './enums';
import { FORWARD_ORDER, RERUNNABLE_STATES, checkMove, completedStates, isLegalMove, legalMoves, loopLimitMessage, orderOf, rerunCount, type MoveRecord } from './moves';
import { checkTransition } from './state-machine';

/** A ticket that went forward through these states, one advance at a time. */
const walk = (...path: TicketStatus[]): MoveRecord[] => path.slice(1).map((to, i) => ({ fromStatus: path[i] as TicketStatus, toStatus: to, kind: 'advance' }));
const upToReview = walk('NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW');

describe('completedStates', () => {
  it('a forward move completes the state it leaves', () => {
    expect([...completedStates(upToReview)]).toEqual(['NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS']);
  });
  it('a rerun un-completes the target and everything after it, always (D4)', () => {
    const done = completedStates([...upToReview, { fromStatus: 'REVIEW', toStatus: 'PLANNING', kind: 'rerun' }]);
    expect([...done]).toEqual(['NEW', 'KB']);
  });
  it('after the rerun the stages complete again as the ticket goes forward', () => {
    const done = completedStates([...upToReview, { fromStatus: 'REVIEW', toStatus: 'BREAKDOWN', kind: 'rerun' }, { fromStatus: 'BREAKDOWN', toStatus: 'IN_PROGRESS', kind: 'advance' }]);
    expect(done.has('BREAKDOWN')).toBe(true);
    expect(done.has('PLANNING')).toBe(true);
    expect(done.has('IN_PROGRESS')).toBe(false);
  });
  it('a rejection at a gate undoes the stage behind it', () => {
    const done = completedStates([...walk('NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL'), { fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'PLANNING', kind: 'reject' }]);
    expect(done.has('PLANNING')).toBe(false);
    expect(done.has('KB')).toBe(true);
  });
  it('holds, resumes and old rows without a kind do not change what is complete', () => {
    const done = completedStates([{ fromStatus: 'NEW', toStatus: 'KB' }, { fromStatus: 'KB', toStatus: 'ON_HOLD', kind: 'hold' }, { fromStatus: 'ON_HOLD', toStatus: 'KB', kind: 'resume' }]);
    expect([...done]).toEqual(['NEW']);
  });
});

describe('legalMoves: every state', () => {
  const moves = (status: TicketStatus, extra: Partial<Parameters<typeof legalMoves>[0]> = {}) => legalMoves({ status, moves: [], ...extra }).map((m) => `${m.kind}:${m.to}`);

  it.each([
    ['NEW', ['advance:KB', 'hold:ON_HOLD', 'fail:FAILED']],
    ['KB', ['advance:PLANNING', 'hold:ON_HOLD', 'fail:FAILED']],
    ['PLANNING', ['advance:AWAITING_PLAN_APPROVAL', 'hold:ON_HOLD', 'fail:FAILED']],
    ['AWAITING_PLAN_APPROVAL', ['approve:BREAKDOWN', 'reject:PLANNING', 'hold:ON_HOLD', 'fail:FAILED']],
    ['BREAKDOWN', ['advance:AWAITING_BREAKDOWN_APPROVAL', 'hold:ON_HOLD', 'fail:FAILED']],
    ['AWAITING_BREAKDOWN_APPROVAL', ['approve:IN_PROGRESS', 'reject:BREAKDOWN', 'hold:ON_HOLD', 'fail:FAILED']],
    ['IN_PROGRESS', ['advance:REVIEW', 'advance:KB_UPDATE', 'hold:ON_HOLD', 'fail:FAILED']],
    ['REVIEW', ['advance:KB_UPDATE', 'advance:AWAITING_CI', 'hold:ON_HOLD', 'fail:FAILED']],
    ['KB_UPDATE', ['advance:AWAITING_CI', 'hold:ON_HOLD', 'fail:FAILED']],
    ['AWAITING_CI', ['advance:IN_HUMAN_REVIEW', 'hold:ON_HOLD', 'fail:FAILED']],
    ['IN_HUMAN_REVIEW', ['advance:DONE', 'hold:ON_HOLD', 'fail:FAILED']],
    ['DONE', []],
  ] as [TicketStatus, string[]][])('%s with no history', (status, expected) => {
    expect(moves(status)).toEqual(expected);
  });

  it('with the plan gate off the planning stage goes straight to breakdown, and the other way round', () => {
    expect(moves('PLANNING', { gates: { plan: false, breakdown: true } })).toContain('advance:BREAKDOWN');
    expect(moves('PLANNING', { gates: { plan: false, breakdown: true } })).not.toContain('advance:AWAITING_PLAN_APPROVAL');
    expect(moves('BREAKDOWN', { gates: { plan: true, breakdown: false } })).toContain('advance:IN_PROGRESS');
    expect(moves('BREAKDOWN', { gates: { plan: true, breakdown: false } })).not.toContain('advance:AWAITING_BREAKDOWN_APPROVAL');
  });

  it('a held ticket can resume, fail or rerun an earlier stage; a failed one retries or reruns', () => {
    const held = legalMoves({ status: 'ON_HOLD', holdFromStatus: 'REVIEW', moves: upToReview }).map((m) => `${m.kind}:${m.to}`);
    expect(held).toEqual(['resume:REVIEW', 'fail:FAILED', 'rerun:KB', 'rerun:PLANNING', 'rerun:BREAKDOWN', 'rerun:IN_PROGRESS']);
    const failed = legalMoves({ status: 'FAILED', holdFromStatus: 'IN_PROGRESS', moves: upToReview.slice(0, -1) }).map((m) => `${m.kind}:${m.to}`);
    expect(failed).toEqual(['retry:IN_PROGRESS', 'rerun:KB', 'rerun:PLANNING', 'rerun:BREAKDOWN']);
  });

  it('a rerun is offered only for stages that finished and lie before the ticket', () => {
    expect(moves('REVIEW', { moves: upToReview })).toEqual(['advance:KB_UPDATE', 'advance:AWAITING_CI', 'hold:ON_HOLD', 'fail:FAILED', 'rerun:KB', 'rerun:PLANNING', 'rerun:BREAKDOWN', 'rerun:IN_PROGRESS']);
    expect(moves('PLANNING', { moves: walk('NEW', 'KB', 'PLANNING') })).toContain('rerun:KB');
    expect(moves('PLANNING', { moves: walk('NEW', 'KB', 'PLANNING') })).not.toContain('rerun:PLANNING'); // not before itself
    expect(moves('NEW').some((m) => m.startsWith('rerun'))).toBe(false);
  });

  it('nothing at all is legal for a DONE ticket, rerun included', () => {
    expect(legalMoves({ status: 'DONE', moves: upToReview })).toEqual([]);
  });

  it('every rerunnable state is a stage that runs, and the order covers every moving state', () => {
    for (const s of RERUNNABLE_STATES) expect(orderOf(s)).toBeGreaterThan(0);
    expect(FORWARD_ORDER.filter((s) => !TICKET_STATUSES.includes(s))).toEqual([]);
    expect(TICKET_STATUSES.filter((s) => !FORWARD_ORDER.includes(s))).toEqual(['ON_HOLD', 'FAILED']);
  });
});

describe('checkMove', () => {
  const at = (status: TicketStatus, m: MoveRecord[] = upToReview, holdFromStatus?: TicketStatus) => ({ status, moves: m, holdFromStatus });

  it('everything that was legal before is still legal: the v0 table decides for every other kind', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        const ctx = { holdFromStatus: from === 'ON_HOLD' || from === 'FAILED' ? ('KB' as const) : undefined };
        expect(checkMove({ status: from, moves: [], ...ctx }, 'advance', to)).toEqual(checkTransition(from, to, ctx));
      }
    }
  });

  it('allows a rerun to a finished earlier stage', () => {
    expect(checkMove(at('REVIEW'), 'rerun', 'PLANNING')).toEqual({ ok: true });
    expect(checkMove(at('ON_HOLD', upToReview, 'REVIEW'), 'rerun', 'BREAKDOWN')).toEqual({ ok: true });
  });
  it('refuses a rerun forwards, to itself, to a gate, to a stage that has not finished, and from DONE', () => {
    expect(checkMove(at('PLANNING', walk('NEW', 'KB', 'PLANNING')), 'rerun', 'REVIEW')).toMatchObject({ ok: false });
    expect(checkMove(at('REVIEW'), 'rerun', 'REVIEW')).toMatchObject({ ok: false, reason: expect.stringContaining('not before') });
    expect(checkMove(at('REVIEW'), 'rerun', 'AWAITING_PLAN_APPROVAL')).toMatchObject({ ok: false, reason: expect.stringContaining('not a stage that can be rerun') });
    expect(checkMove(at('IN_PROGRESS', walk('NEW', 'KB', 'PLANNING')), 'rerun', 'BREAKDOWN')).toMatchObject({ ok: false, reason: expect.stringContaining('has not finished') });
    expect(checkMove(at('DONE'), 'rerun', 'KB')).toMatchObject({ ok: false });
  });
  it('isLegalMove agrees with legalMoves', () => {
    expect(isLegalMove(at('REVIEW'), 'rerun', 'KB')).toBe(true);
    expect(isLegalMove(at('REVIEW'), 'rerun', 'KB_UPDATE')).toBe(false);
  });
});

describe('loop limits', () => {
  it('counts reruns of the same stage', () => {
    const m: MoveRecord[] = [{ fromStatus: 'REVIEW', toStatus: 'PLANNING', kind: 'rerun' }, { fromStatus: 'REVIEW', toStatus: 'PLANNING', kind: 'rerun' }, { fromStatus: 'REVIEW', toStatus: 'KB', kind: 'rerun' }, { fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'PLANNING', kind: 'reject' }];
    expect(rerunCount(m, 'PLANNING')).toBe(2);
    expect(rerunCount(m, 'KB')).toBe(1);
  });
  it('says what limit was reached in plain words', () => {
    expect(loopLimitMessage('ciFix', 1)).toBe('The limit of 1 round for fixing a failed CI run was reached.');
    expect(loopLimitMessage('userRerun', 5, 'PLANNING')).toBe('The limit of 5 rounds for rerunning the same stage (PLANNING) was reached.');
  });
});
