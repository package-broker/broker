import { afterEach, describe, expect, it, vi } from 'vitest';
import * as verifier from '@package-broker/core/secrets/keyring-verifier';
import { createWorker, type Env } from './index.js';

const PUBLIC_URL = 'https://broker.test';
const KEY_V1 = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KEY_V2 = 'pbmk_v2_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const db = {
  prepare() {
    throw new Error('Unexpected database access');
  },
} as unknown as NonNullable<Env['DB']>;
function env(db: NonNullable<Env['DB']>, overrides: Record<string, string> = {}): Env {
  return { DB: db, PB_PUBLIC_URL: PUBLIC_URL, PB_MASTER_KEY: KEY_V1, ...overrides } as Env;
}
afterEach(() => vi.restoreAllMocks());
describe('Worker failed build cache', () => {
  it('caches a KernelConfigError for 30 seconds per fingerprint and immediately retries changed configuration', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const verify = vi
      .spyOn(verifier, 'verifyKeyring')
      .mockRejectedValue(new verifier.KeyringMismatchError(1));
    const worker = createWorker([], { log: () => undefined });
    const request = () => new Request(`${PUBLIC_URL}/_pb/auth/providers`);
    expect((await worker.fetch(request(), env(db))).status).toBe(503);
    now += 29_999;
    expect((await worker.fetch(request(), env(db))).status).toBe(503);
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await worker.fetch(request(), env(db, { PB_MASTER_KEY: KEY_V2 }))).status).toBe(503);
    expect(verify).toHaveBeenCalledTimes(2);
    now += 1;
    expect((await worker.fetch(request(), env(db))).status).toBe(503);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('retries failures other than KernelConfigError immediately', async () => {
    const verify = vi
      .spyOn(verifier, 'verifyKeyring')
      .mockRejectedValue(new TypeError('Unavailable'));
    const worker = createWorker([], { log: () => undefined });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (await worker.fetch(new Request(`${PUBLIC_URL}/_pb/auth/providers`), env(db))).status,
      ).toBe(500);
    }
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
