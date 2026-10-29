import { createElement, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ReadableList } from './readable-list.js';
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
afterEach(() => vi.clearAllMocks());
const columns = [
  { key: 'name', label: 'Project', value: (item: { name: string; count: number }) => item.name },
  { key: 'count', label: 'Count', value: (item: { name: string; count: number }) => item.count },
];
const items = [
  { id: 'hidden-id-one', name: 'Acme Company', count: 100 },
  { id: 'hidden-id-two', name: 'Sample Business', count: 9 },
];
it('provides semantic headers, visible card labels and page-only sorting without ID columns', () => {
  const html = renderToString(
    createElement(ReadableList<(typeof items)[number]>, { label: 'Projects', items, columns }),
  );
  expect(html).toContain('<caption class="sr-only">Projects</caption>');
  expect(html).toContain('scope="col"');
  expect(html).toContain('scope="row"');
  expect(html).toContain('>Count</dt>');
  expect(html).toContain('Sort this page');
  expect(html).toContain('Sorting applies to this page');
  expect(html).not.toContain('hidden-id');
  expect(html).not.toContain('Columns ·');
  expect(html).not.toContain('Scroll horizontally');
});
it('sorts numeric values numerically in both representations without mutating input', () => {
  vi.mocked(useState).mockReturnValueOnce(['count:asc', vi.fn()]);
  const html = renderToString(
    createElement(ReadableList<(typeof items)[number]>, { label: 'Projects', items, columns }),
  );
  const [desktop, mobile] = html.split('<ul');
  for (const representation of [desktop!, mobile!]) {
    expect(representation).toContain('Sample Business');
    expect(representation).toContain('Acme Company');
    expect(representation.indexOf('Sample Business')).toBeLessThan(
      representation.indexOf('Acme Company'),
    );
  }
  expect(html).toContain('aria-sort="ascending"');
  expect(items[0]?.name).toBe('Acme Company');
});
