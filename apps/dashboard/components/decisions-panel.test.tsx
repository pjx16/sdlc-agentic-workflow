import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionsPanel } from './decisions-panel';
import type { DecisionView } from '@/lib/types';

const d = (over: Partial<DecisionView> = {}): DecisionView => ({
  id: 'd1', at: '2026-11-14T10:00:00Z', point: 'kb_update', question: 'Is the KB update worth running?',
  options: [{ kind: 'advance', to: 'KB_UPDATE', label: 'Move on to KB_UPDATE' }, { kind: 'advance', to: 'AWAITING_CI', label: 'Move on to AWAITING_CI' }],
  chosen: 'advance AWAITING_CI', reason: 'Only a test changed.', fallbackUsed: false, model: 'haiku', costUsd: 0.0012, ...over,
});

describe('DecisionsPanel', () => {
  it('shows the question, the options with the chosen one marked, and the reason', () => {
    render(<DecisionsPanel decisions={[d()]} />);
    expect(screen.getByText('Is the KB update worth running?')).toBeInTheDocument();
    const chosen = screen.getByText(/Move on to AWAITING_CI/);
    expect(chosen).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText(/Move on to KB_UPDATE/)).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Only a test changed.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Orchestrator decisions' })).queryByText('default used')).not.toBeInTheDocument();
  });
  it('says when the default was used because the answer was not usable', () => {
    render(<DecisionsPanel decisions={[d({ fallbackUsed: true, reason: '' })]} />);
    expect(screen.getByText('default used')).toBeInTheDocument();
  });
  it('explains an empty list', () => {
    render(<DecisionsPanel decisions={[]} />);
    expect(screen.getByText(/has not been asked anything/)).toBeInTheDocument();
  });
});
