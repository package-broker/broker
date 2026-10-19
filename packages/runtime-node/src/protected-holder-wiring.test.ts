import { expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { createUnlinkRepository } from '@package-broker/db-sqlite/repositories/unlink';

import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createNodeServer } from './index.js';

vi.mock('@package-broker/db-sqlite/repositories/unlink', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@package-broker/db-sqlite/repositories/unlink')>();
  return { ...actual, createUnlinkRepository: vi.fn(actual.createUnlinkRepository) };
});

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

it('builds unlink holder checks without a host freshness clock', async () => {
  const broker = createNodeServer([], {
    log: () => undefined,
    auth: {
      keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
      publicOrigin: 'http://127.0.0.1',
      env: {},
    },
  });
  try {
    await broker.ready();
    expect(createUnlinkRepository).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(createUnlinkRepository).mock.calls[0]!;
    expect(await options.holderInput(orgContext('clock-test'))).toEqual({
      kind: 'fresh',
      providers: [],
    });
  } finally {
    await broker.close();
  }
});
