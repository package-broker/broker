import { expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { createUnlinkRepository } from '@package-broker/db-sqlite/repositories/unlink';

import { createWorker } from './index.js';
import type { Env } from './index.js';

vi.mock('@package-broker/db-sqlite/repositories/unlink', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@package-broker/db-sqlite/repositories/unlink')>();
  return { ...actual, createUnlinkRepository: vi.fn(actual.createUnlinkRepository) };
});

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

it('builds unlink holder checks without a host freshness clock', async () => {
  const worker = createWorker([], { log: () => undefined });
  const response = await worker.fetch(
    new Request('https://broker.example.test/_pb/auth/providers'),
    {
      DB: {
        prepare: vi.fn(() => {
          throw new Error('unexpected query');
        }),
        batch: vi.fn(async () => []),
      },
      PB_MASTER_KEY: KEY,
      PB_PUBLIC_URL: 'https://broker.example.test',
    } as unknown as Env,
  );
  expect(response.status).toBe(200);
  expect(createUnlinkRepository).toHaveBeenCalledTimes(1);
  const [, options] = vi.mocked(createUnlinkRepository).mock.calls[0]!;
  expect(await options.holderInput(orgContext('clock-test'))).toEqual({
    kind: 'fresh',
    providers: [],
  });
});
