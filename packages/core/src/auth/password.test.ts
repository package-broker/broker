import { createHmac, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyring } from '../secrets/keyring.js';
import type { Keyring } from '../secrets/keyring.js';
import { SecretsConfigError } from '../secrets/master-key.js';
import type { MasterKey } from '../secrets/master-key.js';
import {
  PASSWORD_HASH_PATTERN,
  PASSWORD_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  hashPassword,
  passwordProblems,
  selfTestPasswordHashing,
  verifyDummy,
  verifyPassword,
} from './password.js';

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

const V1 = (): MasterKey => masterKey(1, 0x00);
const V2 = (): MasterKey => masterKey(2, 0x20);
const PASSWORD = 'correct horse battery staple';
const SALT = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);
const VECTOR =
  'pbkdf2-sha256$i=100000$v=1$oKGio6SlpqeoqaqrrK2urw$K7MuJuKUZ7oO7dy0yZlMHaJS4zt5QunqAXSi_Zf584U';

function encode(
  key: MasterKey,
  password: string,
  iterations: number,
  salt: Uint8Array = SALT,
): string {
  const pepper = Buffer.from(
    hkdfSync('sha256', key.bytes, new Uint8Array(0), 'package-broker/v1/password-pepper', 32),
  );
  const input = createHmac('sha256', pepper).update(password.normalize('NFC'), 'utf8').digest();
  const derived = pbkdf2Sync(input, salt, iterations, 32, 'sha256');
  return `pbkdf2-sha256$i=${iterations}$v=${key.version}$${Buffer.from(salt).toString('base64url')}$${derived.toString('base64url')}`;
}

type DeriveBits = typeof crypto.subtle.deriveBits;

function countDeriveBits(): { iterations: number[] } {
  const seen: number[] = [];
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(((...args: Parameters<DeriveBits>) => {
    const algorithm = args[0] as { name: string; iterations?: number };
    if (algorithm.name === 'PBKDF2') seen.push(algorithm.iterations as number);
    return original(...args);
  }) as DeriveBits);
  return { iterations: seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('limits', () => {
  it('keeps the configured iteration count within the production Workers cap', () => {
    expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
    expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
    expect(PASSWORD_ITERATIONS).toBe(100_000);
  });

  it('matches the published vector shape and nothing malformed', () => {
    expect(PASSWORD_HASH_PATTERN.test(VECTOR)).toBe(true);
    const bad = [
      VECTOR.replace('i=100000', 'i=0999'),
      VECTOR.replace('i=100000', 'i=1000000'),
      VECTOR.replace('i=100000', 'i=999'),
      VECTOR.replace('v=1', 'v=0'),
      VECTOR.replace('v=1', 'v=1000000'),
      VECTOR.replace('oKGio6SlpqeoqaqrrK2urw', 'oKGio6SlpqeoqaqrrK2ur'),
      VECTOR.replace('oKGio6SlpqeoqaqrrK2urw', 'oKGio6SlpqeoqaqrrK2urw+'),
      VECTOR.slice(0, -1),
      `${VECTOR}A`,
      `${VECTOR}\n`,
      `x${VECTOR}`,
      VECTOR.replace('K7MuJu', 'K7+uJu'),
    ];
    for (const value of bad) expect(PASSWORD_HASH_PATTERN.test(value)).toBe(false);
  });
});

describe('verifyPassword', () => {
  it('verifies the published vector recomputed with node:crypto', async () => {
    expect(encode(V1(), PASSWORD, 100_000)).toBe(VECTOR);
    const keyring = createKeyring([V1()]);
    expect(await verifyPassword(VECTOR, PASSWORD, keyring)).toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('treats NFC-equivalent passwords as equal', async () => {
    const keyring = createKeyring([V1()]);
    const composed = 'café au lait 12345';
    const decomposed = 'café au lait 12345';
    const stored = encode(V1(), composed, 100_000);
    expect((await verifyPassword(stored, decomposed, keyring)).ok).toBe(true);
    expect((await verifyPassword(stored, composed, keyring)).ok).toBe(true);
  });

  it('rejects a wrong password after one 100 000 iteration derivation', async () => {
    const keyring = createKeyring([V1()]);
    const counter = countDeriveBits();
    expect(await verifyPassword(VECTOR, 'wrong horse battery staple', keyring)).toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(counter.iterations).toEqual([100_000]);
  });

  const invalid: ReadonlyArray<readonly [string, string]> = [
    ['a truncated hash', VECTOR.slice(0, -1)],
    ['a hash with a trailing character', `${VECTOR}A`],
    ['an unloaded key version', VECTOR.replace('$v=1$', '$v=9$')],
    ['v=0', VECTOR.replace('$v=1$', '$v=0$')],
    ['i=999', VECTOR.replace('i=100000', 'i=999')],
    ['i=1000 with the right password', encode(V1(), PASSWORD, 1_000)],
    ['i=99999 with the right password', encode(V1(), PASSWORD, 99_999)],
    ['i=100001', VECTOR.replace('i=100000', 'i=100001')],
    ['i=1000000', VECTOR.replace('i=100000', 'i=1000000')],
    ['a leading zero in i', VECTOR.replace('i=100000', 'i=0100000')],
    ['a foreign scheme', VECTOR.replace('pbkdf2-sha256', 'pbkdf2-sha512')],
    ['an empty string', ''],
    ['a non-canonical salt', VECTOR.replace('oKGio6SlpqeoqaqrrK2urw', 'oKGio6SlpqeoqaqrrK2urx')],
  ];

  it.each(invalid)('rejects %s without throwing, after one dummy derivation', async (_, bad) => {
    const keyring = createKeyring([V1()]);
    const counter = countDeriveBits();
    await expect(verifyPassword(bad, PASSWORD, keyring)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(counter.iterations).toEqual([100_000]);
  });

  it('runs the dummy derivation for an unloaded version even when the pepper lookup rejects', async () => {
    const keyring = createKeyring([V2()]);
    const counter = countDeriveBits();
    const stored = encode(V1(), PASSWORD, 100_000);
    await expect(verifyPassword(stored, PASSWORD, keyring)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(counter.iterations).toEqual([100_000]);
  });

  it('verifies a hash made under ring [v1] under [v2, v1] and asks for a rehash', async () => {
    const stored = await hashPassword(PASSWORD, createKeyring([V1()]));
    const rotated = createKeyring([V2(), V1()]);
    expect(await verifyPassword(stored, PASSWORD, rotated)).toEqual({
      ok: true,
      needsRehash: true,
    });
  });

  it('refuses a hash with another iteration count and a wrong password after one 100 000 derivation', async () => {
    const keyring = createKeyring([V1()]);
    const stored = encode(V1(), PASSWORD, 1_000);
    const counter = countDeriveBits();
    expect(await verifyPassword(stored, 'wrong horse battery staple', keyring)).toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(counter.iterations).toEqual([100_000]);
  });

  it('does not ask for a rehash on a wrong password against an old-version hash', async () => {
    const stored = await hashPassword(PASSWORD, createKeyring([V1()]));
    const rotated = createKeyring([V2(), V1()]);
    expect(await verifyPassword(stored, 'wrong horse battery staple', rotated)).toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('does not look up a pepper for an unloaded version', async () => {
    const real = createKeyring([V1()]);
    const requested: number[] = [];
    const keyring: Keyring = {
      currentVersion: real.currentVersion,
      versions: real.versions,
      aesKey: (purpose, version) => real.aesKey(purpose, version),
      hmacKey: (purpose, version) => {
        requested.push(version);
        return real.hmacKey(purpose, version);
      },
    };
    const counter = countDeriveBits();
    const stored = VECTOR.replace('$v=1$', '$v=9$');
    expect((await verifyPassword(stored, PASSWORD, keyring)).ok).toBe(false);
    expect(requested).toEqual([1]);
    expect(counter.iterations).toEqual([100_000]);
  });

  it('refuses a lone surrogate password on the dummy path even with the right hash', async () => {
    const keyring = createKeyring([V1()]);
    const password = `${PASSWORD}\ud800`;
    const stored = encode(V1(), password, 100_000);
    const counter = countDeriveBits();
    expect(await verifyPassword(stored, password, keyring)).toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(counter.iterations).toEqual([100_000]);
  });

  it('refuses passwords over 1024 UTF-16 units on the dummy path, accepts 1024', async () => {
    const keyring = createKeyring([V1()]);
    const long = 'a'.repeat(1_025);
    const edge = 'a'.repeat(1_024);
    const counter = countDeriveBits();
    expect(await verifyPassword(encode(V1(), long, 100_000), long, keyring)).toEqual({
      ok: false,
      needsRehash: false,
    });
    expect((await verifyPassword(encode(V1(), edge, 100_000), edge, keyring)).ok).toBe(true);
    expect(counter.iterations).toEqual([100_000, 100_000]);
  });

  it('rejects when deriveBits rejects, instead of reporting a verdict', async () => {
    const keyring = createKeyring([V1()]);
    vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(new Error('boom'));
    await expect(verifyPassword(VECTOR, PASSWORD, keyring)).rejects.toThrow('boom');
    await expect(hashPassword(PASSWORD, keyring)).rejects.toThrow('boom');
  });

  it('never puts the password in an error message', async () => {
    const keyring = createKeyring([V1()]);
    const secret = 'Tr0ub4dor&3-unique-marker';
    vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(
      Object.assign(new Error('Pbkdf2 failed'), { name: 'NotSupportedError' }),
    );
    const failures = await Promise.all(
      [
        verifyPassword(VECTOR, secret, keyring),
        verifyPassword('garbage', secret, keyring),
        hashPassword(secret, keyring),
        verifyDummy(secret, keyring),
        selfTestPasswordHashing(keyring),
      ].map((attempt) =>
        attempt.then(
          () => undefined,
          (error: unknown) => error as Error,
        ),
      ),
    );
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(`${failure?.name} ${failure?.message}`).not.toContain(secret);
    }
  });
});

describe('hashPassword', () => {
  it('produces a pattern-conforming value that verifies and uses a fresh salt', async () => {
    const keyring = createKeyring([V2(), V1()]);
    const first = await hashPassword(PASSWORD, keyring);
    const second = await hashPassword(PASSWORD, keyring);
    expect(first).toMatch(PASSWORD_HASH_PATTERN);
    expect(first).toContain('i=100000$v=2$');
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, PASSWORD, keyring)).toEqual({
      ok: true,
      needsRehash: false,
    });
  });
});

describe('hashPassword input guard', () => {
  it.each([
    ['a lone high surrogate', `${PASSWORD}\ud800`],
    ['a lone low surrogate', `\udc00${PASSWORD}`],
    ['1025 UTF-16 code units', 'a'.repeat(1_025)],
  ])(
    'throws TypeError for %s before deriving, without the password in the message',
    async (_, password) => {
      const counter = countDeriveBits();
      const failure = await hashPassword(password, createKeyring([V1()])).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure).toBeInstanceOf(TypeError);
      expect(failure?.message).toBe('password cannot be hashed');
      expect(counter.iterations).toEqual([]);
    },
  );

  it('hashes 1024 code units and a well-formed surrogate pair, and verify accepts both', async () => {
    const keyring = createKeyring([V1()]);
    for (const password of ['a'.repeat(1_024), `${PASSWORD}\u{1F600}`]) {
      const stored = await hashPassword(password, keyring);
      expect((await verifyPassword(stored, password, keyring)).ok).toBe(true);
    }
  });
});

describe('verifyDummy', () => {
  it('resolves false after one 100 000 iteration derivation', async () => {
    const counter = countDeriveBits();
    expect(await verifyDummy(PASSWORD, createKeyring([V1()]))).toBe(false);
    expect(counter.iterations).toEqual([100_000]);
  });
});

describe('selfTestPasswordHashing', () => {
  it('resolves on Node with one 100 000 iteration derivation', async () => {
    const counter = countDeriveBits();
    await expect(selfTestPasswordHashing(createKeyring([V1()]))).resolves.toBeUndefined();
    expect(counter.iterations).toEqual([100_000]);
  });

  it('throws SecretsConfigError when deriveBits refuses like production', async () => {
    vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(
      Object.assign(new Error('Pbkdf2 failed: iteration counts above 100000 are not supported'), {
        name: 'NotSupportedError',
      }),
    );
    const failure = await selfTestPasswordHashing(createKeyring([V1()])).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SecretsConfigError);
    expect(failure).toMatchObject({ problem: 'malformed', variable: 'PASSWORD_ITERATIONS' });
  });
});

describe('passwordProblems', () => {
  const email = 'Admin@Example.com';

  it('flags 11 code points as too short and accepts 12', () => {
    expect(passwordProblems('a'.repeat(11), email)).toEqual(['too_short']);
    expect(passwordProblems('a'.repeat(12), email)).toEqual([]);
  });

  it('flags 129 code points as too long and accepts 128', () => {
    expect(passwordProblems('a'.repeat(129), email)).toEqual(['too_long']);
    expect(passwordProblems('a'.repeat(128), email)).toEqual([]);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(passwordProblems('\u{1F600}'.repeat(12), email)).toEqual([]);
    expect(passwordProblems('\u{1F600}'.repeat(128), email)).toEqual([]);
    expect(passwordProblems('\u{1F600}'.repeat(129), email)).toEqual(['too_long']);
  });

  it('flags the e-mail address in any case', () => {
    expect(passwordProblems('ADMIN@EXAMPLE.COM', email)).toEqual(['equals_email']);
    expect(passwordProblems('admin@example.com', email)).toEqual(['equals_email']);
  });

  it('flags a lone surrogate as not well formed', () => {
    expect(passwordProblems(`${'a'.repeat(12)}\ud800`, email)).toEqual(['not_well_formed']);
    expect(passwordProblems(`\udc00${'a'.repeat(12)}`, email)).toEqual(['not_well_formed']);
    expect(passwordProblems('\u{1F600}'.repeat(12), email)).toEqual([]);
  });

  it('reports several problems together', () => {
    expect(passwordProblems('a@b.c', 'A@B.C')).toEqual(['too_short', 'equals_email']);
  });
});
