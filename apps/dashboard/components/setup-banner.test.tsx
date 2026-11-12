import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SetupBanner } from './setup-banner';

describe('SetupBanner', () => {
  it('names what is missing and links to the connections page', () => {
    render(<SetupBanner missing={['claude_token', 'git_author_email']} />);
    expect(screen.getByRole('alert')).toHaveTextContent('the Claude token, the git author email');
    expect(screen.getByRole('link', { name: /Finish setup/ })).toHaveAttribute('href', '/setup/connections');
  });
  it('mentions the admin password when it is missing', () => {
    render(<SetupBanner missing={[]} adminCreated={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('the admin password');
  });
  it('renders nothing when nothing is missing', () => {
    const { container } = render(<SetupBanner missing={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
