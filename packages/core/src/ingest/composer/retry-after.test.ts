import { describe, expect, it } from 'vitest';
import { retryAfterOf } from './retry-after.js';

const NOW = Date.parse('Sat, 17 Oct 2026 10:00:00 GMT');

describe('retryAfterOf', () => {
  it.each([
    ['0', 0],
    ['7', 7],
    ['61', 61],
    ['86400', 86400],
    ['86401', 86400],
    ['9'.repeat(400), 86400],
    ['Sat, 17 Oct 2026 10:00:30 GMT', 30],
    ['Sat, 17 Oct 2026 09:59:59 GMT', 0],
    ['Mon, 19 Oct 2026 10:00:00 GMT', 86400],
  ])('parses and bounds %s', (header, seconds) => {
    expect(retryAfterOf(header, NOW)).toBe(seconds);
  });

  it.each([
    null,
    '-5',
    '1.5',
    '12 apples',
    '',
    ' ',
    ' 7 ',
    '+5',
    '2026-10-17T10:00:30Z',
    'Saturday, 17-Oct-26 10:00:30 GMT',
    'Sat Oct 17 10:00:30 2026',
    'Sat, 17 Oct 2026 10:00:30 UTC',
    'Sat, 17 Oct 2026 10:00 GMT',
    'Sat, 17 Oct 2026 10:00:30 GMT trailing',
    'Fri, 17 Oct 2026 10:00:30 GMT',
    'Tue, 31 Feb 2026 10:00:30 GMT',
    'Sat, 17 Oct 2026 24:00:00 GMT',
  ])('rejects %s', (header) => {
    expect(retryAfterOf(header, NOW)).toBeUndefined();
  });
});
