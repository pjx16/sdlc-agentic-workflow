import { describe, expect, it } from 'vitest';
import { legalMoves } from './moves';
import { DECISION_POINTS, automaticMoves, decisionPointOf, validateDecision } from './orchestrator';

describe('orchestrator decisions', () => {
  const moves = automaticMoves(legalMoves({ status: 'REVIEW', moves: [] } as never));
  it('only moving on is automatic, and a review has two ways on', () => {
    expect(moves.map((m) => m.to)).toEqual(['KB_UPDATE', 'AWAITING_CI']);
    expect(automaticMoves(legalMoves({ status: 'KB', moves: [] } as never)).map((m) => m.to)).toEqual(['PLANNING']);
  });
  it('knows its decision points, with thinking only there', () => {
    expect(decisionPointOf('REVIEW')).toBe('kb_update');
    expect(decisionPointOf('KB')).toBeNull();
    expect(DECISION_POINTS.kb_update.thinking).toBe(true);
  });
  it('accepts a legal move and rejects anything else', () => {
    expect(validateDecision({ kind: 'advance', to: 'AWAITING_CI' }, moves)).toMatchObject({ ok: true, move: { to: 'AWAITING_CI' } });
    expect(validateDecision({ kind: 'advance', to: 'DONE' }, moves)).toMatchObject({ ok: false });
    expect(validateDecision({ kind: 'fail', to: 'AWAITING_CI' }, moves)).toMatchObject({ ok: false });
    expect(validateDecision(null, moves)).toMatchObject({ ok: false });
  });
});
