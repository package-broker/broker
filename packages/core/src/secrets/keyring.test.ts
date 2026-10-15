import { hkdfSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnknownKeyVersionError, createKeyring } from './keyring.js';
import type { CryptoKey } from './keyring.js';
import type { MasterKey } from './master-key.js';

const encoder = new TextEncoder();

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('hex');
}

function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

async function hmac(key: CryptoKey, message: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function rawDerived(key: MasterKey, purpose: string): Uint8Array {
  return new Uint8Array(
    hkdfSync('sha256', key.bytes, new Uint8Array(0), `package-broker/v1/${purpose}`, 32),
  );
}

const V1 = (): MasterKey => masterKey(1, 0x00);
const V2 = (): MasterKey => masterKey(2, 0x20);
const TOKEN_VECTOR = '911431492c817eaab40082eaba3347f0c4dcba2b069a55246760161ee1c4b369';
const PASSWORD_VECTOR = '8b17ac6eec5e5099801608ade1749175569ccb6e17d93a228857040b9de5a932';
const AES_VECTOR = '63ae7b7fed5219b0cf66530cd6cf8d7ae0e9f0b9b3eea32ce78cd8fdb2';
const AAD = 'credential/01JABCDEFGHJKMNPQRSTVWXYZ0/01J00000000000000000000A0A/github-app-key';
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => index);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKeyring', () => {
  it('reports the current version first and every loaded version', () => {
    const ring = createKeyring([V2(), V1()]);

    expect(ring.currentVersion).toBe(2);
    expect(ring.versions).toEqual([2, 1]);
  });

  it('rejects an empty key list with TypeError', () => {
    expect(() => createKeyring([])).toThrow(TypeError);
  });

  it('rejects duplicate versions with TypeError', () => {
    expect(() => createKeyring([V1(), V1()])).toThrow(TypeError);
    expect(() => createKeyring([V2(), V1(), V2()])).toThrow(TypeError);
  });

  it('rejects versions that are not strictly descending with TypeError', () => {
    expect(() => createKeyring([V1(), V2()])).toThrow(TypeError);
  });

  it('rejects keys that are not 32 bytes or have an invalid version with TypeError', () => {
    expect(() => createKeyring([{ version: 1, bytes: new Uint8Array(31) }])).toThrow(TypeError);
    expect(() => createKeyring([{ version: 0, bytes: new Uint8Array(32) }])).toThrow(TypeError);
    expect(() => createKeyring([{ version: 1.5, bytes: new Uint8Array(32) }])).toThrow(TypeError);
  });

  it('accepts four keys and derives keys for all four versions', async () => {
    const ring = createKeyring([
      masterKey(4, 0x60),
      masterKey(3, 0x40),
      masterKey(2, 0x20),
      masterKey(1, 0x00),
    ]);

    expect(ring.versions).toEqual([4, 3, 2, 1]);
    const outputs = new Set<string>();
    for (const version of ring.versions) {
      const aes = await ring.aesKey('credential-encryption', version);
      const mac = await ring.hmacKey('token-pepper', version);
      expect(aes.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
      expect(mac.algorithm).toMatchObject({ name: 'HMAC' });
      outputs.add(await hmac(mac, 'pb-test-message'));
    }
    expect(outputs.size).toBe(4);
  });

  it('rejects five keys with TypeError', () => {
    expect(() =>
      createKeyring([
        masterKey(5, 0x80),
        masterKey(4, 0x60),
        masterKey(3, 0x40),
        masterKey(2, 0x20),
        masterKey(1, 0x00),
      ]),
    ).toThrow(TypeError);
  });
});

describe('derived key vectors', () => {
  it('reproduces the token pepper HMAC vector', async () => {
    const ring = createKeyring([V1()]);

    expect(await hmac(await ring.hmacKey('token-pepper', 1), 'pb-test-message')).toBe(TOKEN_VECTOR);
  });

  it('reproduces the password pepper HMAC vector', async () => {
    const ring = createKeyring([V1()]);

    expect(
      await hmac(await ring.hmacKey('password-pepper', 1), 'correct horse battery staple'),
    ).toBe(PASSWORD_VECTOR);
  });

  it('reproduces the AES-GCM vector and matches a key imported from node:crypto HKDF output', async () => {
    const ring = createKeyring([V1()]);
    const key = await ring.aesKey('credential-encryption', 1);
    const params = { name: 'AES-GCM', iv: NONCE, additionalData: encoder.encode(AAD) };

    const sealed = await crypto.subtle.encrypt(params, key, encoder.encode('hello, broker'));
    expect(hex(sealed)).toBe(AES_VECTOR);

    const reference = await crypto.subtle.importKey(
      'raw',
      rawDerived(V1(), 'credential-encryption'),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    expect(
      hex(await crypto.subtle.encrypt(params, reference, encoder.encode('hello, broker'))),
    ).toBe(AES_VECTOR);
    expect(new TextDecoder().decode(await crypto.subtle.decrypt(params, key, sealed))).toBe(
      'hello, broker',
    );
  });

  it('matches node:crypto HKDF for the documented raw vectors', () => {
    expect(hex(rawDerived(V1(), 'credential-encryption'))).toBe(
      'aca72565542c818c009f0880e3c42f734dfb80c4f27926f8e7d006420ab84211',
    );
    expect(hex(rawDerived(V1(), 'login-state'))).toBe(
      '5a7cf25c502dd55d4e48d1a8d0abfa0109edf1000a77f94a6c9f0ac20673f034',
    );
    expect(hex(rawDerived(V2(), 'credential-encryption'))).toBe(
      '6f35fd700d0d503c80d246f19a2e42bf4ad54550fd140e0aeceb8432bb26cc63',
    );
    expect(hex(rawDerived(V1(), 'token-pepper'))).toBe(
      '8c8339b137c3ecaa5608b9ff3bcbcf49c474864ebd5e2785e4a83ad9f09c4a60',
    );
    expect(hex(rawDerived(V1(), 'password-pepper'))).toBe(
      '4b9dfeed61a7e87fb7f7f0c93b83a03ebe3ab781f8ee842aaa44b3120a4220fa',
    );
  });

  it('derives HMAC keys from the node:crypto HKDF output of the same purpose', async () => {
    const ring = createKeyring([V2(), V1()]);
    for (const [purpose, version, master] of [
      ['token-pepper', 1, V1()],
      ['password-pepper', 2, V2()],
    ] as const) {
      const reference = await crypto.subtle.importKey(
        'raw',
        rawDerived(master, purpose),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      expect(await hmac(await ring.hmacKey(purpose, version), 'm')).toBe(
        await hmac(reference, 'm'),
      );
    }
  });

  it('derives login-state AES keys that match node:crypto HKDF output', async () => {
    const ring = createKeyring([V1()]);
    const params = { name: 'AES-GCM', iv: NONCE };
    const reference = await crypto.subtle.importKey(
      'raw',
      fromHex('5a7cf25c502dd55d4e48d1a8d0abfa0109edf1000a77f94a6c9f0ac20673f034'),
      'AES-GCM',
      false,
      ['encrypt'],
    );

    const left = await crypto.subtle.encrypt(
      params,
      await ring.aesKey('login-state', 1),
      encoder.encode('x'),
    );
    const right = await crypto.subtle.encrypt(params, reference, encoder.encode('x'));
    expect(hex(left)).toBe(hex(right));
  });
});

describe('key separation', () => {
  it('gives different HMAC outputs for different purposes and versions', async () => {
    const ring = createKeyring([V2(), V1()]);
    const outputs = [
      await hmac(await ring.hmacKey('token-pepper', 1), 'same input'),
      await hmac(await ring.hmacKey('token-pepper', 2), 'same input'),
      await hmac(await ring.hmacKey('password-pepper', 1), 'same input'),
      await hmac(await ring.hmacKey('password-pepper', 2), 'same input'),
    ];

    expect(new Set(outputs).size).toBe(4);
  });

  it('gives different AES ciphertexts for different purposes and versions', async () => {
    const ring = createKeyring([V2(), V1()]);
    const params = { name: 'AES-GCM', iv: NONCE };
    const outputs: string[] = [];
    for (const purpose of ['credential-encryption', 'login-state'] as const) {
      for (const version of [1, 2]) {
        const key = await ring.aesKey(purpose, version);
        outputs.push(hex(await crypto.subtle.encrypt(params, key, encoder.encode('same input'))));
      }
    }

    expect(new Set(outputs).size).toBe(4);
  });

  it('rejects a purpose that does not belong to the key type', async () => {
    const ring = createKeyring([V1()]);

    await expect(ring.aesKey('token-pepper' as unknown as 'login-state', 1)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      ring.hmacKey('login-state' as unknown as 'token-pepper', 1),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('non-extractable keys', () => {
  it('reports extractable false and key usages', async () => {
    const ring = createKeyring([V1()]);
    const aes = await ring.aesKey('login-state', 1);
    const mac = await ring.hmacKey('password-pepper', 1);

    expect(aes.extractable).toBe(false);
    expect([...aes.usages].sort()).toEqual(['decrypt', 'encrypt']);
    expect(mac.extractable).toBe(false);
    expect([...mac.usages].sort()).toEqual(['sign', 'verify']);
  });

  it('rejects exportKey for every derived key', async () => {
    const ring = createKeyring([V1()]);
    const keys = [
      await ring.aesKey('credential-encryption', 1),
      await ring.aesKey('login-state', 1),
      await ring.hmacKey('token-pepper', 1),
      await ring.hmacKey('password-pepper', 1),
    ];

    for (const key of keys) {
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    }
  });
});

describe('unknown versions', () => {
  it('rejects with UnknownKeyVersionError carrying the version', async () => {
    const ring = createKeyring([V2(), V1()]);

    const aes = await ring.aesKey('credential-encryption', 7).catch((error: unknown) => error);
    expect(aes).toBeInstanceOf(UnknownKeyVersionError);
    expect((aes as UnknownKeyVersionError).version).toBe(7);
    expect((aes as UnknownKeyVersionError).name).toBe('UnknownKeyVersionError');

    const mac = await ring.hmacKey('token-pepper', 0).catch((error: unknown) => error);
    expect(mac).toBeInstanceOf(UnknownKeyVersionError);
    expect((mac as UnknownKeyVersionError).version).toBe(0);
  });

  it('names only the version in the error message', async () => {
    const ring = createKeyring([V1()]);

    const error = (await ring.hmacKey('token-pepper', 9).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Master key version 9 is not loaded');
  });
});

describe('memoization', () => {
  it('returns the same CryptoKey instance for one purpose and version', async () => {
    const ring = createKeyring([V2(), V1()]);

    expect(await ring.aesKey('credential-encryption', 1)).toBe(
      await ring.aesKey('credential-encryption', 1),
    );
    expect(await ring.hmacKey('token-pepper', 2)).toBe(await ring.hmacKey('token-pepper', 2));
    expect(await ring.aesKey('credential-encryption', 1)).not.toBe(
      await ring.aesKey('credential-encryption', 2),
    );
  });

  it('shares one derivation between concurrent callers', async () => {
    const ring = createKeyring([V1()]);
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey');

    const [left, right] = await Promise.all([
      ring.hmacKey('token-pepper', 1),
      ring.hmacKey('token-pepper', 1),
    ]);

    expect(left).toBe(right);
    expect(deriveKey).toHaveBeenCalledTimes(1);
  });

  it('does not memoize a rejected derivation', async () => {
    const ring = createKeyring([V1()]);
    const deriveKey = vi
      .spyOn(crypto.subtle, 'deriveKey')
      .mockRejectedValueOnce(new Error('transient'));

    await expect(ring.hmacKey('token-pepper', 1)).rejects.toThrow('transient');
    const key = await ring.hmacKey('token-pepper', 1);

    expect(await hmac(key, 'pb-test-message')).toBe(TOKEN_VECTOR);
    expect(deriveKey).toHaveBeenCalledTimes(2);
  });
});

describe('input isolation', () => {
  it('is not affected by mutating the input bytes before any derivation (guards against a lazy base-key import)', async () => {
    const input = V1();
    const ring = createKeyring([input]);

    input.bytes.fill(0xff);

    expect(await hmac(await ring.hmacKey('token-pepper', 1), 'pb-test-message')).toBe(TOKEN_VECTOR);
  });

  it('is not affected by mutating the input bytes after the first derivation', async () => {
    const input = V1();
    const ring = createKeyring([input]);
    await ring.hmacKey('token-pepper', 1);

    input.bytes.fill(0x00);

    expect(
      await hmac(await ring.hmacKey('password-pepper', 1), 'correct horse battery staple'),
    ).toBe(PASSWORD_VECTOR);
    const aes = await ring.aesKey('credential-encryption', 1);
    const params = { name: 'AES-GCM', iv: NONCE, additionalData: encoder.encode(AAD) };
    expect(hex(await crypto.subtle.encrypt(params, aes, encoder.encode('hello, broker')))).toBe(
      AES_VECTOR,
    );
  });

  it('freezes the keyring and its versions list', () => {
    const ring = createKeyring([V2(), V1()]);

    expect(Object.isFrozen(ring)).toBe(true);
    expect(Object.isFrozen(ring.versions)).toBe(true);
    expect(() => (ring.versions as number[]).push(3)).toThrow(TypeError);
    expect(ring.versions).toEqual([2, 1]);
  });
});
