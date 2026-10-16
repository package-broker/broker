import { createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyring } from './keyring.js';
import type { MasterKey } from './master-key.js';
import { dummyVerify, hashToken, verifyToken } from './token-hash.js';
import { formatToken } from './token-format.js';

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

const V1 = masterKey(1, 0x00);
const V2 = masterKey(2, 0x20);
const SELECTOR_OK = 'abcdefghijkl';
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 1);
const TOKEN = formatToken('pat', SELECTOR_OK, SECRET_BYTES);
const keyring = createKeyring([V2, V1]);

function expected(key: MasterKey, token: string): string {
  const pepper = Buffer.from(
    hkdfSync('sha256', key.bytes, new Uint8Array(0), 'package-broker/v1/token-pepper', 32),
  );
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

function flip(text: string, index: number): string {
  const current = text.charAt(index);
  const replacement = current === 'a' ? 'b' : 'a';
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hashToken', () => {
  it('matches an independent HMAC-SHA-256 vector per pepper version', async () => {
    const v1 = await hashToken(keyring, 1, TOKEN);
    const v2 = await hashToken(keyring, 2, TOKEN);
    expect(v1).toBe(expected(V1, TOKEN));
    expect(v2).toBe(expected(V2, TOKEN));
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(v1).not.toBe(v2);
  });

  it('changes at every byte position of the canonical token', async () => {
    const base = await hashToken(keyring, 2, TOKEN);
    for (let index = 0; index < TOKEN.length; index += 1) {
      const altered = flip(TOKEN, index);
      expect(await hashToken(keyring, 2, altered)).not.toBe(base);
    }
  });

  it('covers kind, selector and secret in the hashed string', async () => {
    const svc = formatToken('svc', SELECTOR_OK, SECRET_BYTES);
    const other = formatToken('pat', 'abcdefghijkm', SECRET_BYTES);
    const base = await hashToken(keyring, 2, TOKEN);
    expect(await hashToken(keyring, 2, svc)).not.toBe(base);
    expect(await hashToken(keyring, 2, other)).not.toBe(base);
    expect(await hashToken(keyring, 2, svc)).toBe(expected(V2, svc));
  });

  it('rejects an unloaded pepper version', async () => {
    await expect(hashToken(keyring, 3, TOKEN)).rejects.toThrow();
  });
});

describe('verifyToken', () => {
  it('accepts the correct hash for each retained version', async () => {
    for (const [version, key] of [
      [1, V1],
      [2, V2],
    ] as const) {
      expect(await verifyToken(keyring, version, TOKEN, expected(key, TOKEN))).toBe(true);
    }
  });

  it('refuses a hash computed under another version', async () => {
    expect(await verifyToken(keyring, 2, TOKEN, expected(V1, TOKEN))).toBe(false);
  });

  it('refuses every altered byte position of the token', async () => {
    const stored = expected(V2, TOKEN);
    for (let index = 0; index < TOKEN.length; index += 1) {
      expect(await verifyToken(keyring, 2, flip(TOKEN, index), stored)).toBe(false);
    }
  });

  it('refuses a wrong stored hash at every hex position', async () => {
    const stored = expected(V2, TOKEN);
    for (let index = 0; index < stored.length; index += 1) {
      const replacement = stored.charAt(index) === '0' ? '1' : '0';
      const wrong = stored.slice(0, index) + replacement + stored.slice(index + 1);
      expect(await verifyToken(keyring, 2, TOKEN, wrong)).toBe(false);
    }
  });

  const malformed: Array<[string, unknown]> = [
    ['empty', ''],
    ['short', 'ab'],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['uppercase hex', expected(V2, TOKEN).toUpperCase()],
    ['padded', ` ${expected(V2, TOKEN).slice(1)}`],
    ['non-string', 42],
    ['null', null],
  ];

  it.each(malformed)(
    'refuses a malformed stored hash (%s) after a dummy verification',
    async (_n, value) => {
      const verify = vi.spyOn(crypto.subtle, 'verify');
      expect(await verifyToken(keyring, 2, TOKEN, value as string)).toBe(false);
      expect(verify).toHaveBeenCalledTimes(1);
      const data = verify.mock.calls[0]?.[2] as ArrayBuffer | Uint8Array;
      expect(data.byteLength).toBe(32);
    },
  );

  it.each(malformed)(
    'stays false for malformed hash (%s) even if verify resolves true',
    async (_n, value) => {
      vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(true);
      expect(await verifyToken(keyring, 2, TOKEN, value as string)).toBe(false);
    },
  );

  it('stays false for an unknown version even if verify resolves true', async () => {
    vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(true);
    expect(await verifyToken(keyring, 3, TOKEN, expected(V2, TOKEN))).toBe(false);
  });

  it('verifies the encoded token on the real path', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify');
    await verifyToken(keyring, 2, TOKEN, expected(V2, TOKEN));
    expect(Array.from(verify.mock.calls[0]?.[3] as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode(TOKEN)),
    );
  });

  it('rethrows keyring failures other than an unknown version', async () => {
    const broken = { ...keyring, hmacKey: () => Promise.reject(new RangeError('boom')) };
    await expect(verifyToken(broken, 2, TOKEN, expected(V2, TOKEN))).rejects.toThrow('boom');
  });

  it('dummyVerify makes one verify call over the token and returns false', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(true);
    expect(await dummyVerify(TOKEN)).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(Array.from(verify.mock.calls[0]?.[2] as Uint8Array)).toEqual(new Array(32).fill(0));
    expect(Array.from(verify.mock.calls[0]?.[3] as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode(TOKEN)),
    );
  });

  it('refuses an unknown pepper version after a dummy verification', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify');
    expect(await verifyToken(keyring, 3, TOKEN, expected(V2, TOKEN))).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(Array.from(verify.mock.calls[0]?.[2] as Uint8Array)).toEqual(
      Array.from(Buffer.from(expected(V2, TOKEN), 'hex')),
    );
    expect(Array.from(verify.mock.calls[0]?.[3] as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode(TOKEN)),
    );
  });

  it('refuses invalid versions without throwing', async () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(await verifyToken(keyring, version, TOKEN, expected(V2, TOKEN))).toBe(false);
    }
  });

  it('uses the same observable path for a valid and a refused attempt', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify');
    await verifyToken(keyring, 2, TOKEN, expected(V2, TOKEN));
    await verifyToken(keyring, 2, TOKEN, 'zz');
    await verifyToken(keyring, 9, TOKEN, expected(V2, TOKEN));
    expect(verify).toHaveBeenCalledTimes(3);
    const lengths = verify.mock.calls.map((call) => (call[2] as Uint8Array).byteLength);
    expect(lengths).toEqual([32, 32, 32]);
  });

  it('delegates the comparison to crypto.subtle.verify', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(true);
    expect(await verifyToken(keyring, 2, TOKEN, 'a'.repeat(64))).toBe(true);
    expect(verify).toHaveBeenCalled();
    verify.mockResolvedValue(false);
    expect(await verifyToken(keyring, 2, TOKEN, expected(V2, TOKEN))).toBe(false);
  });

  it('contains no string equality on hashes in the source', () => {
    const source = readFileSync(new URL('./token-hash.ts', import.meta.url), 'utf8');
    expect(source).toContain('crypto.subtle.verify');
    expect(source).not.toMatch(/[!=]==?\s*(stored|expected|hash)/i);
    expect(source).not.toMatch(/(stored|expected|hash)\w*\s*[!=]==?/i);
    expect(source).not.toContain('constantTimeEqual');
  });
});
