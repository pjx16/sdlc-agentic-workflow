import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CredentialView } from '@sdlc/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsForm } from './credentials-form';

const view = (key: CredentialView['key'], over: Partial<CredentialView> = {}): CredentialView => ({ key, source: 'unset', hint: null, verifiedAt: null, verifyError: null, updatedAt: null, ...over });
const ALL: CredentialView['key'][] = ['claude_token', 'github_token', 'git_author_name', 'git_author_email', 'jira_base_url', 'jira_email', 'jira_api_token'];
const fetchMock = vi.fn();

describe('CredentialsForm', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  it('never renders a secret: only the last four characters as a hint, in an empty password input', () => {
    const { container } = render(<CredentialsForm initial={ALL.map((k) => view(k, k === 'github_token' ? { source: 'db', hint: 'wxyz' } : {}))} />);
    expect(screen.getByText('••••wxyz')).toBeInTheDocument();
    const input = screen.getByLabelText('GitHub token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain('ghp_');
  });

  it('shows a value set in .env as read-only, without a Save button for it', () => {
    render(<CredentialsForm initial={ALL.map((k) => view(k, k === 'claude_token' ? { source: 'env', hint: 'abcd' } : {}))} />);
    expect(screen.getByLabelText('Claude token')).toBeDisabled();
    expect(screen.getAllByText('Set in .env').length).toBeGreaterThan(0);
  });

  it('saves a value with PUT and clears the input', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => view('github_token', { source: 'db', hint: 'wxyz' }) });
    render(<CredentialsForm initial={ALL.map((k) => view(k))} />);
    await userEvent.type(screen.getByLabelText('GitHub token'), 'ghp_abcdefghijklmnopqrstuvwxyz');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/credentials/github_token', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 'ghp_abcdefghijklmnopqrstuvwxyz' }) })));
    expect(await screen.findByText('••••wxyz')).toBeInTheDocument();
    expect((screen.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('');
  });

  it('shows the result of a connection test', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, message: 'Connected as octo' }) });
    render(<CredentialsForm initial={ALL.map((k) => view(k, k === 'github_token' ? { source: 'db', hint: 'wxyz' } : {}))} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Test' })[1]!);
    expect(await screen.findByRole('status')).toHaveTextContent('Connected as octo');
    expect(fetchMock).toHaveBeenCalledWith('/api/credentials/github_token/test', { method: 'POST' });
  });

  it('warns when ENCRYPTION_KEY is not set', () => {
    render(<CredentialsForm initial={ALL.map((k) => view(k))} encryptionKeyOk={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('ENCRYPTION_KEY is not set');
  });
});
