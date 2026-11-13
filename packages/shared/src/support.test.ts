import { describe, expect, it } from 'vitest';
import { SUPPORT_ACTIONS, SUPPORT_KINDS, countsForBadge, defaultPriority, inboxGroup } from './support';

describe('support ticket kinds', () => {
  it('every kind has actions and a default priority from the plan table', () => {
    for (const k of SUPPORT_KINDS) expect(SUPPORT_ACTIONS[k].length).toBeGreaterThan(0);
    expect(SUPPORT_KINDS.filter((k) => defaultPriority(k) === 'blocking').sort()).toEqual(['approval', 'ci_infra', 'credential', 'hold', 'onboarding', 'question']);
    expect(defaultPriority('open_question')).toBe('normal');
    expect(defaultPriority('pr_ready')).toBe('fyi');
  });
  it('an approval is one item under Approvals, never also under Blocking', () => {
    expect(inboxGroup({ kind: 'approval', priority: 'blocking' })).toBe('approvals');
    expect(inboxGroup({ kind: 'hold', priority: 'blocking' })).toBe('blocking');
    expect(inboxGroup({ kind: 'question', priority: 'blocking' })).toBe('questions');
    expect(inboxGroup({ kind: 'open_question', priority: 'normal' })).toBe('questions');
    expect(inboxGroup({ kind: 'pr_ready', priority: 'fyi' })).toBe('fyi');
  });
  it('the badge counts open blocking and approval items only', () => {
    expect(countsForBadge({ kind: 'approval', priority: 'normal', status: 'open' })).toBe(true);
    expect(countsForBadge({ kind: 'hold', priority: 'blocking', status: 'open' })).toBe(true);
    expect(countsForBadge({ kind: 'hold', priority: 'blocking', status: 'resolved' })).toBe(false);
    expect(countsForBadge({ kind: 'pr_ready', priority: 'fyi', status: 'open' })).toBe(false);
    expect(countsForBadge({ kind: 'open_question', priority: 'normal', status: 'open' })).toBe(false);
  });
});
