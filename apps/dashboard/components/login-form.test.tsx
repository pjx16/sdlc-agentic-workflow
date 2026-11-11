import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));

const fetchMock = vi.fn();

async function submit(password: string) {
  render(<LoginForm />);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    replace.mockReset();
    refresh.mockReset();
  });

  it('posts the password to /api/auth/login and goes to the overview on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await submit('secret');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'secret' }) }),
    );
  });

  it('shows a message for a wrong password and stays on the page', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await submit('nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.');
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows the lockout message on 429', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    await submit('nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many failed attempts');
  });

  it('shows a message when the server cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await submit('x');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server.');
  });
});
