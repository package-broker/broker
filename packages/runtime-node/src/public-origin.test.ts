import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicOrigin from '@package-broker/core/kernel/public-origin';

afterEach(() => vi.restoreAllMocks());
import { startNode } from './startup.js';

describe('Node startup public origin errors', () => {
  it.each([
    [undefined, 'is missing'],
    ['', 'is missing'],
    ['broker', 'is not an absolute URL'],
    ['http://public.test', 'must be https, or http on a loopback host'],
    ['https://user:password@broker.test', 'must be an origin without path, query or credentials'],
    ['https://broker.test/?', 'must be an origin without path, query or credentials'],
    ['https://broker.test/#', 'must be an origin without path, query or credentials'],
  ])('keeps the safe startup error for %j', async (raw, problem) => {
    await expect(
      startNode({
        plugins: [],
        migrations: [],
        log: () => undefined,
        env: {
          PB_SQLITE_PATH: ':memory:',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: raw,
        },
      }),
    ).rejects.toMatchObject({
      name: 'StartupConfigError',
      variable: 'PB_PUBLIC_URL',
      message: `PB_PUBLIC_URL ${problem}`,
    });
  });
});

it('propagates unexpected parser failures in Node startup', async () => {
  const failure = new Error('unexpected');
  vi.spyOn(publicOrigin, 'parsePublicOrigin').mockImplementation(() => {
    throw failure;
  });
  await expect(
    startNode({
      plugins: [],
      migrations: [],
      log: () => undefined,
      env: {
        PB_SQLITE_PATH: ':memory:',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
      },
    }),
  ).rejects.toBe(failure);
});
