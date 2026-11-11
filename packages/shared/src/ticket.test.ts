import { describe, expect, it } from 'vitest';
import { JIRA_KEY_PATTERN, PasteTicketSchema, mapJiraIssueType } from './ticket';
import { zodFields } from './zod-utils';

describe('PasteTicketSchema', () => {
  it('accepts a minimal ticket and applies defaults', () => {
    expect(PasteTicketSchema.parse({ projectId: 'p1', title: '  Add a thing  ' })).toEqual({ projectId: 'p1', title: 'Add a thing', body: '', type: 'story', featureKey: undefined });
  });
  it('keeps type, body and feature key', () => {
    expect(PasteTicketSchema.parse({ projectId: 'p1', title: 't', body: 'b', type: 'bug', featureKey: 'billing-export' })).toMatchObject({ type: 'bug', body: 'b', featureKey: 'billing-export' });
  });
  it('treats a blank feature key as absent', () => {
    expect(PasteTicketSchema.parse({ projectId: 'p1', title: 't', featureKey: '  ' }).featureKey).toBeUndefined();
  });
  it('reports field-level errors', () => {
    const f = zodFields(PasteTicketSchema.safeParse({ title: '', type: 'epic', featureKey: 'Not Valid' }).error!);
    expect(Object.keys(f).sort()).toEqual(['featureKey', 'projectId', 'title', 'type']);
    expect(f.type).toBe('must be one of story, bug, tech');
    expect(zodFields(PasteTicketSchema.safeParse({ projectId: 'p', title: 'x'.repeat(201) }).error!).title).toBe('must be at most 200 characters');
  });
});

describe('mapJiraIssueType (F3)', () => {
  it('maps bug, story and user story case-insensitively, and everything else to tech', () => {
    expect(mapJiraIssueType('Bug')).toBe('bug');
    expect(mapJiraIssueType(' BUG ')).toBe('bug');
    expect(mapJiraIssueType('Story')).toBe('story');
    expect(mapJiraIssueType('User Story')).toBe('story');
    for (const other of ['Task', 'Epic', 'Sub-task', 'Improvement', '', undefined, null]) expect(mapJiraIssueType(other), String(other)).toBe('tech');
  });
});

describe('JIRA_KEY_PATTERN', () => {
  it('accepts real keys and rejects anything else', () => {
    for (const ok of ['ABC-1', 'SAM1-10', 'A1B-999']) expect(JIRA_KEY_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['abc-1', 'A-1', 'ABC-', 'ABC-1x', '1ABC-1', 'ABC 1', 'ABC-1\nINJECT', '']) expect(JIRA_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});
