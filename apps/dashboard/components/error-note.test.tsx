import { render, screen } from '@testing-library/react';
import { ERROR_CODES, ERROR_POLICY } from '@sdlc/shared';
import { describe, expect, it, vi } from 'vitest';
import { ErrorNote } from './error-note';
import { PauseBanner } from './pause-banner';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

describe('ErrorNote', () => {
  it.each(ERROR_CODES)('%s shows its source badge, the message and the suggested action', (code) => {
    render(<ErrorNote code={code} message="something happened" />);
    expect(screen.getByTestId('error-source')).toHaveTextContent(ERROR_POLICY[code].badge);
    expect(screen.getByText('something happened')).toBeInTheDocument();
    expect(screen.getByText(ERROR_POLICY[code].action)).toBeInTheDocument();
  });

  it('shows the time of the next automatic attempt, but only while it is in the future', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { rerender } = render(<ErrorNote code="CLAUDE_API_ERROR" message="overloaded" retryAt={future} />);
    expect(screen.getByText(/Next attempt/)).toBeInTheDocument();
    rerender(<ErrorNote code="CLAUDE_API_ERROR" message="overloaded" retryAt={new Date(Date.now() - 1000).toISOString()} />);
    expect(screen.queryByText(/Next attempt/)).not.toBeInTheDocument();
  });

  it('shows an old run without a code as plain red text', () => {
    render(<ErrorNote code={null} message="old failure" />);
    expect(screen.getByText('old failure')).toBeInTheDocument();
    expect(screen.queryByTestId('error-source')).not.toBeInTheDocument();
  });
});

describe('PauseBanner with an error code', () => {
  it('names Claude and says what to do', () => {
    render(<PauseBanner code="CLAUDE_AUTH" reason="Claude rejected the credential. Update it in Settings → Connections." resetsAt={null} />);
    expect(screen.getByTestId('error-source')).toHaveTextContent('Claude');
    expect(screen.getByText(/Update the Claude token/)).toBeInTheDocument();
  });
});
