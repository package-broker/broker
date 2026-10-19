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

function keyringOnlyD1(): NonNullable<Env['DB']> {
  const verifier = new Map<number, string>();
  type Recorded = {
    sql: string;
    values: unknown[];
    bind: (...next: unknown[]) => Recorded;
    all: () => Promise<unknown>;
  };
  const run = (sql: string, values: unknown[]) => {
    const insert = /^\s*insert into keyring_verifier .*X'([0-9a-f]{64})'/is.exec(sql);
    if (insert !== null) {
      const version = values[0] as number;
      if (verifier.has(version)) return { results: [], meta: { changes: 0 } };
      verifier.set(version, (insert[1] as string).toUpperCase());
      return { results: [], meta: { changes: 1 } };
    }
    if (/from "keyring_verifier"/i.test(sql)) {
      return {
        results: [...verifier]
          .sort(([left], [right]) => right - left)
          .map(([key_version, mac_hex]) => ({ key_version, mac_hex })),
      };
    }
    if (/from (?:local_login|credential|token)\b/i.test(sql)) return { results: [] };
    throw new Error('unexpected SQL');
  };
  const make = (sql: string, values: unknown[]): Recorded => ({
    sql,
    values,
    bind: (...next) => make(sql, next),
    all: () => Promise.resolve(run(sql, values)),
  });
  return {
    prepare: (sql: string) => make(sql, []),
    batch: (statements: Recorded[]) =>
      Promise.resolve(statements.map((statement) => run(statement.sql, statement.values))),
  } as unknown as NonNullable<Env['DB']>;
}

it('builds unlink holder checks without a host freshness clock', async () => {
  const worker = createWorker([], { log: () => undefined });
  const response = await worker.fetch(
    new Request('https://broker.example.test/_pb/auth/providers'),
    {
      DB: keyringOnlyD1(),
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
