import { describe, expect, it, vi } from 'vitest';
import { AppJwtError, createAppJwt } from './app-jwt.js';

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const PKCS8_HEADER_LENGTH_2048 = 26;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function pem(label: string, der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const pair = await crypto.subtle.generateKey(
  { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ['sign', 'verify'],
);
const pkcs8Der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const spkiDer = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const ecDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', ec.privateKey));
const small = await crypto.subtle.generateKey(
  { ...RSA, modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ['sign'],
);
const rsa1024Der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', small.privateKey));
const pkcs8 = pem('PRIVATE KEY', pkcs8Der);
const pkcs1 = pem('RSA PRIVATE KEY', pkcs8Der.slice(PKCS8_HEADER_LENGTH_2048));
const spki = pem('PUBLIC KEY', spkiDer);
const encrypted = pkcs1.replace(
  '-----BEGIN RSA PRIVATE KEY-----\n',
  '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00112233445566778899AABBCCDDEEFF\n\n',
);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>;
}

async function verifies(jwt: string): Promise<boolean> {
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  return crypto.subtle.verify(
    RSA.name,
    pair.publicKey,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

async function failure(run: () => Promise<unknown>): Promise<AppJwtError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppJwtError);
    return error as AppJwtError;
  }
  throw new Error('expected rejection');
}

describe('createAppJwt', () => {
  it.each([
    ['PKCS#1', pkcs1],
    ['PKCS#8', pkcs8],
  ])('signs a verifiable RS256 JWT from a %s key', async (_name, key) => {
    const jwt = await createAppJwt(key, '12345', 1_800_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(await verifies(jwt)).toBe(true);
    expect(decode(parts[0]!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(parts[1]!)).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '12345' });
  });

  it('accepts CRLF line endings and surrounding whitespace', async () => {
    const jwt = await createAppJwt(`\n${pkcs1.replace(/\n/g, '\r\n')}\n`, '1', 1_800_000_000);
    expect(await verifies(jwt)).toBe(true);
  });

  it('produces a 256-byte signature that fails once the payload changes', async () => {
    const jwt = await createAppJwt(pkcs8, '1', 1_800_000_000);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    expect(fromBase64Url(signature)).toHaveLength(256);
    const other = (await createAppJwt(pkcs8, '2', 1_800_000_000)).split('.')[1];
    expect(await verifies(`${header}.${other}.${signature}`)).toBe(false);
    expect(await verifies(`${header}.${payload}.${signature}`)).toBe(true);
  });

  it('imports the key non-extractable with sign usage only', async () => {
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    try {
      await createAppJwt(pkcs8, '1', 1_800_000_000);
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]!;
      expect(args[0]).toBe('pkcs8');
      expect(args[3]).toBe(false);
      expect(args[4]).toEqual(['sign']);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['empty', ''],
    ['no PEM armor', 'not a key'],
    [
      'unsupported type',
      '-----BEGIN EC PRIVATE KEY-----\nQUJDREVGRw==\n-----END EC PRIVATE KEY-----',
    ],
    [
      'bad base64',
      '-----BEGIN RSA PRIVATE KEY-----\n@@@@SECRETBODY@@@@\n-----END RSA PRIVATE KEY-----',
    ],
    ['garbage DER', '-----BEGIN PRIVATE KEY-----\nU0VDUkVUQk9EWUJZVEVT\n-----END PRIVATE KEY-----'],
    ['public key', spki],
    ['ECDSA P-256 under PRIVATE KEY', pem('PRIVATE KEY', ecDer)],
    ['ECDSA P-256 under RSA PRIVATE KEY', pem('RSA PRIVATE KEY', ecDer)],
    ['oversized input', `${pkcs8}${'A'.repeat(16384)}`],
    ['truncated armored body', pem('PRIVATE KEY', pkcs8Der.slice(0, 300))],
    ['encrypted PKCS#1', encrypted],
    ['RSA-1024', pem('PRIVATE KEY', rsa1024Der)],
  ])('rejects a malformed key (%s) with invalid_key and no key material', async (_name, key) => {
    const error = await failure(() => createAppJwt(key, '1', 1_800_000_000));
    expect(error.code).toBe('invalid_key');
    expect(error.message).not.toMatch(/BEGIN|END|SECRET|U0VDUkVU|QUJDREVGRw|MII/);
    expect(error.cause).toBeUndefined();
  });

  it('never leaks the key body of a truncated real key', async () => {
    const body = pkcs8.split('\n')[2]!;
    const error = await failure(() => createAppJwt(pkcs8.slice(0, 200), '1', 1_800_000_000));
    expect(error.code).toBe('invalid_key');
    expect(error.message).not.toContain(body.slice(0, 20));
  });

  it.each(['', 'abc', '12a', '-1', '1.5', ' 12', '0x10', '0123', '1'.repeat(21)])(
    'rejects app id %j with invalid_app_id',
    async (appId) => {
      const error = await failure(() => createAppJwt(pkcs8, appId, 1_800_000_000));
      expect(error.code).toBe('invalid_app_id');
    },
  );

  it('checks the app id before touching the key', async () => {
    const error = await failure(() => createAppJwt('garbage', 'abc', 1_800_000_000));
    expect(error.code).toBe('invalid_app_id');
  });

  it.each([
    0,
    -5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1e11,
    1_800_000_000_000,
    Number.MAX_SAFE_INTEGER + 2,
  ])('rejects clock value %s with invalid_now', async (now) => {
    const error = await failure(() => createAppJwt(pkcs8, '1', now));
    expect(error.code).toBe('invalid_now');
  });
});
