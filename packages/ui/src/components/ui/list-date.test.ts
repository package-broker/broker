import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ListDate } from './list-date.js';
it('keeps the exact instant reachable through a native disclosure', () => {
  const value = '2026-10-28T11:30:00+02:00';
  const html = renderToString(createElement(ListDate, { value }));
  expect(html).toContain('<details>');
  expect(html).toContain('<summary');
  expect(html).toContain(`dateTime="${value}"`);
  expect(html).toContain('2026-10-28T09:30:00.000Z</p>');
});
it('labels an invalid date as unavailable without inventing a timestamp', () => {
  const html = renderToString(createElement(ListDate, { value: 'invalid-date' }));
  expect(html).toContain('Date unavailable');
  expect(html).not.toContain('<time');
  expect(html).not.toContain('invalid-date');
});
