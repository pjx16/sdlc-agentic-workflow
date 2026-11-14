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

  it('defines the six decision points, each with a question; only the KB update belongs to a state', () => {
    expect(Object.keys(DECISION_POINTS)).toEqual(['kb_update', 'review_findings', 'review_limit', 'security_add', 'chore_plan', 'ci_flaky']);
    for (const spec of Object.values(DECISION_POINTS)) expect(spec.question.length).toBeGreaterThan(20);
    expect(decisionPointOf('REVIEW')).toBe('kb_update');
    expect(decisionPointOf('AWAITING_CI')).toBeNull();
  });

  it('validates a choice among options that are not state moves', () => {
    const options = [{ kind: 'fix', to: 'fix', label: 'a' }, { kind: 'support', to: 'support', label: 'b' }];
    expect(validateDecision({ kind: 'support', to: 'support' }, options)).toEqual({ ok: true, move: options[1] });
    expect(validateDecision({ kind: 'ignore', to: 'ignore' }, options)).toMatchObject({ ok: false });
  });
});
