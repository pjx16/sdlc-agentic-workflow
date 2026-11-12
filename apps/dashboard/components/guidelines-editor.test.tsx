import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuidelineNode } from '@/lib/types';
import { GuidelinesEditor } from './guidelines-editor';

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const tree: GuidelineNode[] = [
  { name: 'stages', path: 'stages', type: 'dir', children: [{ name: 'plan.md', path: 'stages/plan.md', type: 'file' }, { name: 'kb build.md', path: 'stages/kb build.md', type: 'file' }] },
  { name: 'default-CLAUDE.md', path: 'default-CLAUDE.md', type: 'file' },
];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('GuidelinesEditor (3.8)', () => {
  it('shows the file tree and asks to choose a file', () => {
    render(<GuidelinesEditor tree={tree} />);
    expect(screen.getByText('stages')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'default-CLAUDE.md' })).toBeInTheDocument();
    expect(screen.getByText(/Choose a file to edit/)).toBeInTheDocument();
  });

  it('has an empty state', () => {
    render(<GuidelinesEditor tree={[]} />);
    expect(screen.getByText('No guideline files found.')).toBeInTheDocument();
  });

  it('opens a file in the editor, escaping the path', async () => {
    fetchMock.mockResolvedValue(reply({ path: 'stages/kb build.md', content: '# KB build' }));
    render(<GuidelinesEditor tree={tree} />);
    await userEvent.click(screen.getByRole('button', { name: 'kb build.md' }));
    expect(await screen.findByLabelText('Content of stages/kb build.md')).toHaveValue('# KB build');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/guidelines/stages/kb%20build.md');
    expect(screen.getByRole('button', { name: 'kb build.md' })).toHaveAttribute('aria-current', 'true');
  });

  it('edits and saves, then confirms that changes apply from the next stage run', async () => {
    fetchMock.mockResolvedValueOnce(reply({ path: 'default-CLAUDE.md', content: '# Rules' })).mockResolvedValueOnce(reply({ path: 'default-CLAUDE.md', bytes: 12 }));
    render(<GuidelinesEditor tree={tree} />);
    await userEvent.click(screen.getByRole('button', { name: 'default-CLAUDE.md' }));
    const editor = await screen.findByLabelText('Content of default-CLAUDE.md');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(); // nothing changed yet
    await userEvent.type(editor, '\nNew rule.');
    expect(screen.getByText('● unsaved')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Changes apply from the next stage run.')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/guidelines/default-CLAUDE.md');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ content: '# Rules\nNew rule.' });
    expect(screen.queryByText('● unsaved')).not.toBeInTheDocument();
  });

  it('shows the server message when a save is rejected, and keeps the edit', async () => {
    fetchMock.mockResolvedValueOnce(reply({ content: 'x' })).mockResolvedValueOnce(reply({ error: 'validation_error', message: 'the file is too large', fields: { content: 'must be at most 200000 bytes' } }, 400));
    render(<GuidelinesEditor tree={tree} />);
    await userEvent.click(screen.getByRole('button', { name: 'default-CLAUDE.md' }));
    await userEvent.type(await screen.findByLabelText('Content of default-CLAUDE.md'), 'more');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be at most 200000 bytes');
    expect(screen.getByLabelText('Content of default-CLAUDE.md')).toHaveValue('xmore');
  });

  it('asks before discarding unsaved changes when switching files, and stays put if declined', async () => {
    fetchMock.mockResolvedValue(reply({ content: 'first' }));
    render(<GuidelinesEditor tree={tree} />);
    await userEvent.click(screen.getByRole('button', { name: 'default-CLAUDE.md' }));
    await userEvent.type(await screen.findByLabelText('Content of default-CLAUDE.md'), '!');
    vi.stubGlobal('confirm', vi.fn(() => false));
    await userEvent.click(screen.getByRole('button', { name: 'plan.md' }));
    expect(window.confirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Content of default-CLAUDE.md')).toHaveValue('first!');
    vi.stubGlobal('confirm', vi.fn(() => true));
    fetchMock.mockResolvedValue(reply({ content: 'second' }));
    await userEvent.click(screen.getByRole('button', { name: 'plan.md' }));
    await waitFor(() => expect(screen.getByLabelText('Content of stages/plan.md')).toHaveValue('second'));
  });

  it('shows an error when a file cannot be opened', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'not_found', message: 'Guideline not found' }, 404));
    render(<GuidelinesEditor tree={tree} />);
    await userEvent.click(screen.getByRole('button', { name: 'plan.md' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Guideline not found');
  });
});
