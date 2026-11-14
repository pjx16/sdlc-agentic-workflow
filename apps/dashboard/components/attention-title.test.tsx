import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttentionTitle } from './attention-title';

describe('AttentionTitle', () => {
  it('puts the number of open items in front of the page title, and keeps it when the title changes', async () => {
    document.head.innerHTML = '<title>Overview</title>';
    const { rerender, unmount } = render(<AttentionTitle count={3} />);
    expect(document.title).toBe('(3) Overview');
    document.title = 'Tickets';
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe('(3) Tickets');
    rerender(<AttentionTitle count={0} />);
    expect(document.title).toBe('Tickets');
    unmount();
  });
});
