import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as cipherModule from './cipher.js';
import {
  CREDENTIAL_KIND_PATTERN,
  SecretDecryptError,
  createSecretCipher,
  credentialAad,
} from './cipher.js';
import type { Sealed, SecretDecryptProblem } from './cipher.js';
import { createKeyring } from './keyring.js';
import type { Keyring } from './keyring.js';
import type { MasterKey } from './master-key.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

const V1 = (): MasterKey => masterKey(1, 0x00);
const V2 = (): MasterKey => masterKey(2, 0x20);
const VECTOR = '63ae7b7fed5219b0cf66530cd6cf8d7ae0e9f0b9b3eea32ce78cd8fdb2';
const IDS = {
  id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  orgId: '01J00000000000000000000A0A',
  kind: 'github-app-key',
};
const AAD = credentialAad(IDS);
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => index);
const DERIVED_V1 = 'aca72565542c818c009f0880e3c42f734dfb80c4f27926f8e7d006420ab84211';

function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

function credentialCipher(...keys: MasterKey[]) {
  return createSecretCipher(createKeyring(keys), 'credential-encryption');
}

async function problemOf(promise: Promise<unknown>): Promise<SecretDecryptProblem | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretDecryptError);
    return (error as SecretDecryptError).problem;
  }
  return undefined;
}

function nodeOpen(key: MasterKey, purpose: string, sealed: Sealed, aad: string): string {
  const derived = new Uint8Array(
    hkdfSync('sha256', key.bytes, new Uint8Array(0), `package-broker/v1/${purpose}`, 32),
  );
  const split = sealed.ciphertext.length - 16;
  const decipher = createDecipheriv('aes-256-gcm', derived, sealed.nonce);
  decipher.setAAD(encoder.encode(aad));
  decipher.setAuthTag(sealed.ciphertext.slice(split));
  return Buffer.concat([
    decipher.update(sealed.ciphertext.slice(0, split)),
    decipher.final(),
  ]).toString('utf8');
}

function derivedKey(key: MasterKey, purpose: string): Uint8Array {
  return new Uint8Array(
    hkdfSync('sha256', key.bytes, new Uint8Array(0), `package-broker/v1/${purpose}`, 32),
  );
}

describe('createSecretCipher', () => {
  it('reproduces the published vector through node:crypto', () => {
    const derived = derivedKey(V1(), 'credential-encryption');
    expect(Buffer.from(derived).toString('hex')).toBe(DERIVED_V1);
    const encipher = createCipheriv('aes-256-gcm', derived, NONCE);
    encipher.setAAD(encoder.encode(AAD));
    const body = Buffer.concat([encipher.update('hello, broker', 'utf8'), encipher.final()]);
    const produced = Buffer.concat([body, encipher.getAuthTag()]);
    expect(produced.toString('hex')).toBe(VECTOR);
    const sealed = { ciphertext: fromHex(VECTOR), nonce: NONCE, keyVersion: 1 };
    expect(nodeOpen(V1(), 'credential-encryption', sealed, AAD)).toBe('hello, broker');
  });

  it('opens the published vector', async () => {
    const cipher = credentialCipher(V1());
    const plaintext = await cipher.open(
      { ciphertext: fromHex(VECTOR), nonce: NONCE, keyVersion: 1 },
      AAD,
    );
    expect(decoder.decode(plaintext)).toBe('hello, broker');
  });

  it('seals so that an independently derived key decrypts', async () => {
    const cipher = credentialCipher(V1());
    const sealed = await cipher.seal(encoder.encode('independent check'), AAD);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.nonce.length).toBe(12);
    expect(sealed.ciphertext.length).toBe('independent check'.length + 16);
    expect(nodeOpen(V1(), 'credential-encryption', sealed, AAD)).toBe('independent check');
    expect(decoder.decode(await cipher.open(sealed, AAD))).toBe('independent check');
  });

  it('round-trips an empty plaintext and the 64 KiB limit', async () => {
    const cipher = credentialCipher(V1());
    const empty = await cipher.seal(new Uint8Array(0), AAD);
    expect(empty.ciphertext.length).toBe(16);
    expect((await cipher.open(empty, AAD)).length).toBe(0);
    const max = new Uint8Array(65_536).fill(7);
    expect(await cipher.open(await cipher.seal(max, AAD), AAD)).toEqual(max);
  });

  it('produces a different nonce and ciphertext for each seal', async () => {
    const cipher = credentialCipher(V1());
    const plaintext = encoder.encode('same plaintext');
    const first = await cipher.seal(plaintext, AAD);
    const second = await cipher.seal(plaintext, AAD);
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  it('rejects oversized plaintext and empty aad', async () => {
    const cipher = credentialCipher(V1());
    await expect(cipher.seal(new Uint8Array(65_537), AAD)).rejects.toBeInstanceOf(RangeError);
    await expect(cipher.seal(encoder.encode('x'), '')).rejects.toBeInstanceOf(TypeError);
    const sealed = await cipher.seal(encoder.encode('x'), AAD);
    await expect(cipher.open(sealed, '')).rejects.toBeInstanceOf(TypeError);
  });

  describe('open failures', () => {
    async function sealed(): Promise<Sealed> {
      return credentialCipher(V1()).seal(encoder.encode('payload'), AAD);
    }

    it('reports authentication_failed for the wrong aad', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      const other = credentialAad({ ...IDS, kind: 'other-kind' });
      expect(await problemOf(cipher.open(value, other))).toBe('authentication_failed');
    });

    it('reports authentication_failed for a flipped nonce byte of the correct length', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      const nonce = value.nonce.slice();
      nonce[5] = (nonce[5] as number) ^ 0x01;
      expect(nonce.length).toBe(12);
      expect(await problemOf(cipher.open({ ...value, nonce }, AAD))).toBe('authentication_failed');
    });

    it.each(['id', 'orgId'] as const)(
      'reports authentication_failed for a wrong %s in the aad',
      async (part) => {
        const cipher = credentialCipher(V1());
        const value = await sealed();
        const other = credentialAad({ ...IDS, [part]: '01JZZZZZZZZZZZZZZZZZZZZZZZ' });
        expect(await problemOf(cipher.open(value, other))).toBe('authentication_failed');
      },
    );

    it('reports authentication_failed for a v1 value labelled version 2', async () => {
      const cipher = credentialCipher(V2(), V1());
      const value = await sealed();
      expect(await problemOf(cipher.open({ ...value, keyVersion: 2 }, AAD))).toBe(
        'authentication_failed',
      );
    });

    it('reports unknown_key_version for a v1 value under a ring that only has v2', async () => {
      const cipher = credentialCipher(V2());
      const value = await sealed();
      expect(await problemOf(cipher.open(value, AAD))).toBe('unknown_key_version');
    });

    it('reports authentication_failed when the keyring rejects a loaded version', async () => {
      const real = createKeyring([V1()]);
      const stub: Keyring = {
        currentVersion: real.currentVersion,
        versions: real.versions,
        aesKey: () => Promise.reject(new Error('key store unavailable')),
        hmacKey: real.hmacKey,
      };
      const value = await sealed();
      const error = await createSecretCipher(stub, 'credential-encryption')
        .open(value, AAD)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretDecryptError);
      expect((error as SecretDecryptError).problem).toBe('authentication_failed');
      expect((error as Error).message).not.toContain('key store unavailable');
    });

    it('reports authentication_failed for a flipped ciphertext bit', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      const ciphertext = value.ciphertext.slice();
      ciphertext[0] = (ciphertext[0] as number) ^ 0x01;
      expect(await problemOf(cipher.open({ ...value, ciphertext }, AAD))).toBe(
        'authentication_failed',
      );
    });

    it('reports authentication_failed for a flipped tag bit', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      const ciphertext = value.ciphertext.slice();
      const last = ciphertext.length - 1;
      ciphertext[last] = (ciphertext[last] as number) ^ 0x80;
      expect(await problemOf(cipher.open({ ...value, ciphertext }, AAD))).toBe(
        'authentication_failed',
      );
    });

    it('reports authentication_failed for a ciphertext shorter than the tag', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      expect(await problemOf(cipher.open({ ...value, ciphertext: new Uint8Array(15) }, AAD))).toBe(
        'authentication_failed',
      );
      expect(await problemOf(cipher.open({ ...value, ciphertext: new Uint8Array(0) }, AAD))).toBe(
        'authentication_failed',
      );
    });

    it('reports bad_nonce for nonces of 11 and 13 bytes', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      for (const length of [0, 11, 13]) {
        expect(await problemOf(cipher.open({ ...value, nonce: new Uint8Array(length) }, AAD))).toBe(
          'bad_nonce',
        );
      }
    });

    it('reports unknown_key_version for a version that is not loaded', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      expect(await problemOf(cipher.open({ ...value, keyVersion: 9 }, AAD))).toBe(
        'unknown_key_version',
      );
    });

    it('never puts plaintext, key or ciphertext in the error', async () => {
      const cipher = credentialCipher(V1());
      const value = await sealed();
      const ciphertext = value.ciphertext.slice();
      ciphertext[0] = (ciphertext[0] as number) ^ 0x01;
      const error = await cipher.open({ ...value, ciphertext }, AAD).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretDecryptError);
      const text = `${(error as Error).name} ${(error as Error).message}`;
      expect(text).not.toContain('payload');
      expect(text).not.toContain(Buffer.from(ciphertext).toString('hex'));
      expect((error as Error).name).toBe('SecretDecryptError');
      expect((error as Error).message).toBe('Secret decryption failed: authentication_failed');
      expect((error as Error).cause).toBeUndefined();
    });
  });

  describe('rotation', () => {
    it('opens a v1 value with ring [v2, v1] and flags it for reseal', async () => {
      const old = await credentialCipher(V1()).seal(encoder.encode('rotating'), AAD);
      const rotated = credentialCipher(V2(), V1());
      expect(rotated.currentVersion).toBe(2);
      expect(decoder.decode(await rotated.open(old, AAD))).toBe('rotating');
      expect(rotated.needsReseal(old)).toBe(true);
      const fresh = await rotated.seal(encoder.encode('rotating'), AAD);
      expect(fresh.keyVersion).toBe(2);
      expect(rotated.needsReseal(fresh)).toBe(false);
      expect(nodeOpen(V2(), 'credential-encryption', fresh, AAD)).toBe('rotating');
    });

    it('reports the single key version as current', () => {
      expect(credentialCipher(V1()).currentVersion).toBe(1);
    });
  });

  it('does not let a login-state cipher open a credential-encryption ciphertext', async () => {
    const keyring = createKeyring([V1()]);
    const credential = createSecretCipher(keyring, 'credential-encryption');
    const login = createSecretCipher(keyring, 'login-state');
    const value = await credential.seal(encoder.encode('scoped'), AAD);
    expect(await problemOf(login.open(value, AAD))).toBe('authentication_failed');
    expect(decoder.decode(await credential.open(value, AAD))).toBe('scoped');
  });

  it('rejects a purpose that is not an AES purpose', () => {
    const keyring = createKeyring([V1()]);
    expect(() => createSecretCipher(keyring, 'token-pepper' as 'login-state')).toThrow(TypeError);
  });

  it('takes exactly a keyring and a purpose and exports no nonce override', () => {
    expect(createSecretCipher.length).toBe(2);
    const cipher = credentialCipher(V1());
    expect(Object.keys(cipher).sort()).toEqual(['currentVersion', 'needsReseal', 'open', 'seal']);
    expect(cipher.seal.length).toBe(2);
    expect(Object.keys(cipherModule).sort()).toEqual([
      'CREDENTIAL_KIND_PATTERN',
      'SecretDecryptError',
      'createSecretCipher',
      'credentialAad',
    ]);
  });
});

describe('SecretDecryptError', () => {
  it('carries the problem and a fixed name', () => {
    const error = new SecretDecryptError('aad_mismatch');
    expect(error.problem).toBe('aad_mismatch');
    expect(error.name).toBe('SecretDecryptError');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('credentialAad', () => {
  it('joins id, org and kind', () => {
    expect(AAD).toBe(
      'credential/01JABCDEFGHJKMNPQRSTVWXYZ0/01J00000000000000000000A0A/github-app-key',
    );
  });

  it.each(['id', 'orgId', 'kind'] as const)('rejects a slash in %s', (part) => {
    expect(() => credentialAad({ ...IDS, [part]: 'a/b' })).toThrow(TypeError);
  });

  it.each(['id', 'orgId', 'kind'] as const)('rejects an empty %s', (part) => {
    expect(() => credentialAad({ ...IDS, [part]: '' })).toThrow(TypeError);
  });

  it.each(['id', 'orgId', 'kind'] as const)('rejects a lone surrogate in %s', (part) => {
    expect(() => credentialAad({ ...IDS, [part]: 'ab\ud800' })).toThrow(TypeError);
    expect(() => credentialAad({ ...IDS, [part]: '\udc00ab' })).toThrow(TypeError);
  });

  it('rejects a kind outside the pattern', () => {
    expect(() => credentialAad({ ...IDS, kind: 'Bad Kind' })).toThrow(TypeError);
    expect(() => credentialAad({ ...IDS, kind: 'a'.repeat(65) })).toThrow(TypeError);
    expect(() => credentialAad({ ...IDS, kind: '-leading' })).toThrow(TypeError);
  });

  it('exports the kind pattern', () => {
    expect(CREDENTIAL_KIND_PATTERN.source).toBe('^[a-z0-9][a-z0-9._-]{0,63}$');
    expect(CREDENTIAL_KIND_PATTERN.test('github-app-key')).toBe(true);
  });
});
