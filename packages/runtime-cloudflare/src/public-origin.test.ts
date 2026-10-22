import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicOrigin from '@package-broker/core/kernel/public-origin';

afterEach(() => vi.restoreAllMocks());
import { publicOriginOf } from './index.js';

describe('Worker public origin policy', () => {
  it.each([
    'http://example.com',
    'http://example.com:8787',
    'http://127.0.0.1:8787/path',
    'https://broker.test/?',
    'https://broker.test/#',
  ])('rejects %s with the existing safe config error', (raw) => {
    expect(() => publicOriginOf(raw)).toThrow(
      expect.objectContaining({
        name: 'SecretsConfigError',
        problem: 'malformed',
        variable: 'PB_PUBLIC_URL',
      }),
    );
  });
});

it.each([
  ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
  ['http://localhost:8787', 'http://localhost:8787'],
  ['http://[::1]:8787', 'http://[::1]:8787'],
  ['http://localhost', 'http://localhost'],
])('accepts loopback http origin %s', (raw, expected) => {
  expect(publicOriginOf(raw)).toBe(expected);
});

it('propagates unexpected parser failures in Workers', () => {
  const failure = new Error('unexpected');
  vi.spyOn(publicOrigin, 'parsePublicOrigin').mockImplementation(() => {
    throw failure;
  });
  expect(() => publicOriginOf('https://broker.test')).toThrow(failure);
});
