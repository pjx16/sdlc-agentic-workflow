import { TICKET_STATUSES } from '@sdlc/shared';
import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, humanizeStatus, statusTone } from './ticket-status';

describe('ticket status display', () => {
  it('humanizes status names', () => {
    expect(humanizeStatus('AWAITING_PLAN_APPROVAL')).toBe('Awaiting plan approval');
    expect(humanizeStatus('NEW')).toBe('New');
    expect(humanizeStatus('IN_HUMAN_REVIEW')).toBe('In human review');
  });

  it('gives every status a tone: green done, red failed, amber waiting or held, accent working, grey new', () => {
    expect(statusTone('DONE')).toBe('green');
    expect(statusTone('FAILED')).toBe('red');
    for (const s of ['ON_HOLD', 'AWAITING_PLAN_APPROVAL', 'AWAITING_BREAKDOWN_APPROVAL', 'AWAITING_CI', 'IN_HUMAN_REVIEW']) expect(statusTone(s), s).toBe('amber');
    for (const s of ['KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE']) expect(statusTone(s), s).toBe('accent');
    expect(statusTone('NEW')).toBe('grey');
    for (const s of TICKET_STATUSES) expect(['grey', 'accent', 'amber', 'green', 'red']).toContain(statusTone(s));
  });

  it('formats dates in a fixed zone, and tolerates missing or invalid values', () => {
    expect(formatDateTime('2026-11-11T16:30:45.000Z')).toBe('2026-11-11 16:30 UTC');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
  });

  it('formats durations', () => {
    expect(formatDuration('2026-01-01T10:00:00Z', '2026-01-01T10:00:42Z')).toBe('42s');
    expect(formatDuration('2026-01-01T10:00:00Z', '2026-01-01T10:03:05Z')).toBe('3m 5s');
    expect(formatDuration(null, '2026-01-01T10:00:00Z')).toBe('—');
    expect(formatDuration('2026-01-01T10:00:00Z', null)).toBe('—');
  });
});
