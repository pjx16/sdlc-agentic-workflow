import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArtifactVersions } from './artifact-versions';
import type { ArtifactView } from '@/lib/types';

const review = (data: unknown): ArtifactView => ({ id: 'a1', stage: 'review', version: 1, data, stale: false, supersededAt: null, stageRunId: null, createdAt: '2026-11-14T10:00:00Z', externalUrl: null }) as ArtifactView;

describe('ArtifactVersions: review criteria', () => {
  it('shows what the PR reviewer decided about each acceptance criterion', () => {
    render(<ArtifactVersions artifacts={[review({ round: 1, findings: [], criteria: [{ criterion: 'Returns rows', met: true, tested: true, note: '' }, { criterion: 'Handles empty', met: true, tested: false, note: 'no test' }] })]} />);
    const table = screen.getByRole('table', { name: 'Acceptance criteria' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent('Handles empty');
    expect(rows[2]).toHaveTextContent('No');
    expect(rows[2]).toHaveTextContent('no test');
  });
  it('shows no table when the review has no criteria', () => {
    render(<ArtifactVersions artifacts={[review({ round: 1, findings: [] })]} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
