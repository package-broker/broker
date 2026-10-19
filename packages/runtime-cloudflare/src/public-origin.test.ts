import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicOrigin from '@package-broker/core/kernel/public-origin';

afterEach(() => vi.restoreAllMocks());
import { publicOriginOf } from './index.js';

describe('Worker public origin policy', () => {
  it.each([
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
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

it('propagates unexpected parser failures in Workers', () => {
  const failure = new Error('unexpected');
  vi.spyOn(publicOrigin, 'parsePublicOrigin').mockImplementation(() => {
    throw failure;
  });
  expect(() => publicOriginOf('https://broker.test')).toThrow(failure);
});
