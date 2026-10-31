import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CopyButton } from './id-text.js';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(['success', 'rejected', 'missing', 'throws'] as const)(
  'copies an ID with %s clipboard and provides an accessible result',
  async (result) => {
    let status = '';
    vi.mocked(useState).mockImplementation(
      () =>
        [
          status,
          (next: string) => {
            status = next;
          },
        ] as never,
    );
    const writeText = vi.fn(() => {
      if (result === 'throws') throw new Error('private-diagnostic');
      return result === 'rejected'
        ? Promise.reject(new Error('private-diagnostic'))
        : Promise.resolve();
    });
    vi.stubGlobal('navigator', { clipboard: result === 'missing' ? undefined : { writeText } });
    const render = () =>
      CopyButton({ value: 'reference-id', label: 'Copy actor ID', manualFallback: true });
    render().props.children[0].props.onClick();
    await Promise.resolve();
    const html = renderToStaticMarkup(render());
    expect(html).toContain('aria-label="Copy actor ID"');
    expect(html).toContain('class="basis-full" role="status"');
    expect(html).not.toContain('private-diagnostic');
    if (result === 'success') {
      expect(writeText).toHaveBeenCalledWith('reference-id');
      expect(html).toContain('ID copied.');
      expect(html).not.toContain('reference-id');
    } else {
      expect(html).toContain('Could not copy ID. Copy the value below.');
      expect(html).toContain('<code class="basis-full break-all">reference-id</code>');
    }
  },
);
