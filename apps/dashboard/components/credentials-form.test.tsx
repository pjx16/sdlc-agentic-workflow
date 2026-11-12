import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CredentialView } from '@sdlc/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsForm } from './credentials-form';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const view = (key: CredentialView['key'], over: Partial<CredentialView> = {}): CredentialView => ({ key, source: 'unset', hint: null, verifiedAt: null, verifyError: null, updatedAt: null, ...over });
const ALL: CredentialView['key'][] = ['claude_token', 'github_token', 'git_author_name', 'git_author_email', 'jira_base_url', 'jira_email', 'jira_api_token'];
const views = (over: Partial<Record<CredentialView['key'], Partial<CredentialView>>> = {}) => ALL.map((k) => view(k, over[k]));
const card = (id: string) => within(screen.getByTestId(`card-${id}`));
const fetchMock = vi.fn();

describe('CredentialsForm', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    refresh.mockReset();
  });

  it('has exactly one Save and one Test button per card (Claude, GitHub, Jira), not one per field', () => {
    render(<CredentialsForm initial={views()} />);
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Test' })).toHaveLength(3);
    expect(card('github').getAllByRole('textbox').length + card('github').getAllByLabelText(/token/i).length).toBeGreaterThan(1);
    expect(card('github').getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  });

  it('never renders a secret: only the last four characters as a hint, in an empty password input', () => {
    const { container } = render(<CredentialsForm initial={views({ github_token: { source: 'db', hint: 'wxyz' } })} />);
    expect(screen.getByText('••••wxyz')).toBeInTheDocument();
    const input = screen.getByLabelText('GitHub token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain('ghp_');
  });

  it('pre-fills plain values so they can be edited, and shows a value set in .env as read-only', () => {
    render(<CredentialsForm initial={views({ git_author_name: { source: 'db', hint: 'Dev Bot' }, claude_token: { source: 'env', hint: 'abcd' } })} />);
    expect((screen.getByLabelText('Git author name') as HTMLInputElement).value).toBe('Dev Bot');
    expect(screen.getByLabelText('Claude token')).toBeDisabled();
    expect(card('claude').queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves every changed field of a card with one Save, then refreshes', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => view(url.split('/').pop() as CredentialView['key'], { source: 'db', hint: 'x' }) }));
    render(<CredentialsForm initial={views()} />);
    expect(card('github').getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('GitHub token'), 'ghp_abcdefghijklmnopqrstuvwxyz');
    await userEvent.type(screen.getByLabelText('Git author name'), 'Dev Bot');
    await userEvent.type(screen.getByLabelText('Git author email'), 'dev@example.com');
    await userEvent.click(card('github').getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(['/api/credentials/git_author_email', '/api/credentials/git_author_name', '/api/credentials/github_token']);
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/credentials/github_token')?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ value: 'ghp_abcdefghijklmnopqrstuvwxyz' }) });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect((screen.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('');
  });

  it('shows a field error and keeps the other fields saved when one value is invalid', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('github_token') ? { ok: false, status: 400, json: async () => ({ fields: { value: 'must be a GitHub personal access token' } }) } : { ok: true, status: 200, json: async () => view('git_author_name', { source: 'db', hint: 'Dev Bot' }) },
    );
    render(<CredentialsForm initial={views()} />);
    await userEvent.type(screen.getByLabelText('GitHub token'), 'nope');
    await userEvent.type(screen.getByLabelText('Git author name'), 'Dev Bot');
    await userEvent.click(card('github').getByRole('button', { name: 'Save' }));
    expect(await card('github').findByRole('alert')).toHaveTextContent('must be a GitHub personal access token');
    expect(refresh).toHaveBeenCalled();
  });

  it('tests the card once and shows the result; Test is disabled while there are unsaved changes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, message: 'Connected as octo' }) });
    render(<CredentialsForm initial={views({ github_token: { source: 'db', hint: 'wxyz' } })} />);
    await userEvent.click(card('github').getByRole('button', { name: 'Test' }));
    expect(await card('github').findByText(/Connected as octo/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/credentials/github_token/test', { method: 'POST' });
    await userEvent.type(screen.getByLabelText('Git author name'), 'x');
    expect(card('github').getByRole('button', { name: 'Test' })).toBeDisabled();
  });

  it('warns when ENCRYPTION_KEY is not set', () => {
    render(<CredentialsForm initial={views()} encryptionKeyOk={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('ENCRYPTION_KEY is not set');
  });
});
