import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const PKCS8_HEADER_LENGTH_2048 = 26;
const NOW = 1_800_000_000;

const APP_JWT_SOURCE = fileURLToPath(
  new URL('../../plugin-github/src/app-jwt.ts', import.meta.url),
);

const WORKER = `
import { AppJwtError, createAppJwt, inspectAppKeyCache } from './app-jwt.js';

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

function fromBase64(text) {
  const normal = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal.padEnd(Math.ceil(normal.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export default {
  async fetch(request) {
    const { key, spki, appId, now, credentialId } = await request.json();
    try {
      const options = credentialId === undefined ? undefined : { credentialId };
      const jwt = await createAppJwt(key, appId, now, options);
      const [header, payload, signature] = jwt.split('.');
      const publicKey = await crypto.subtle.importKey('spki', fromBase64(spki), RSA, false, ['verify']);
      const verified = await crypto.subtle.verify(
        RSA.name,
        publicKey,
        fromBase64(signature),
        new TextEncoder().encode(header + '.' + payload),
      );
      const cache = inspectAppKeyCache().map((entry) => ({
        credentialId: entry.credentialId,
        digest: entry.digest,
        type: entry.type,
        extractable: entry.extractable,
      }));
      return Response.json({ jwt, verified, cache });
    } catch (error) {
      const code = error instanceof AppJwtError ? error.code : 'unexpected';
      return Response.json({ error: code }, { status: 400 });
    }
  },
};
`;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Url(text: string): Uint8Array {
  const normal = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '=')), (char) =>
    char.charCodeAt(0),
  );
}

function pem(label: string, der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>;
}

const pair = await crypto.subtle.generateKey(
  { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ['sign', 'verify'],
);
const pkcs8Der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const spki = toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
const pkcs8 = pem('PRIVATE KEY', pkcs8Der);
const pkcs1 = pem('RSA PRIVATE KEY', pkcs8Der.slice(PKCS8_HEADER_LENGTH_2048));

interface SignResult {
  readonly jwt?: string;
  readonly verified?: boolean;
  readonly cache?: readonly {
    readonly credentialId: string;
    readonly digest: string;
    readonly type: string;
    readonly extractable: boolean;
  }[];
  readonly error?: string;
}

let mf: Miniflare;

beforeAll(async () => {
  const appJwt = stripTypeScriptTypes(await readFile(APP_JWT_SOURCE, 'utf8'));
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        { type: 'ESModule', path: 'worker.js', contents: WORKER },
        { type: 'ESModule', path: 'app-jwt.js', contents: appJwt },
      ],
      compatibilityDate: '2026-10-01',
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  await mf.ready;
});

afterAll(async () => {
  await mf.dispose();
});

async function sign(
  body: Record<string, unknown>,
): Promise<{ status: number; result: SignResult }> {
  const response = await mf.dispatchFetch('http://worker.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spki, appId: '12345', now: NOW, ...body }),
  });
  return { status: response.status, result: (await response.json()) as SignResult };
}

async function verifiesInNode(jwt: string): Promise<boolean> {
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  return crypto.subtle.verify(
    RSA.name,
    pair.publicKey,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

describe('createAppJwt inside workerd', () => {
  it.each([
    ['PKCS#8', pkcs8],
    ['PKCS#1', pkcs1],
  ])('signs a verifiable RS256 JWT from a %s key', async (_name, key) => {
    const { status, result } = await sign({ key });
    expect(result.error).toBeUndefined();
    expect(status).toBe(200);
    expect(result.verified).toBe(true);
    const parts = result.jwt!.split('.');
    expect(parts).toHaveLength(3);
    expect(decode(parts[0]!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(parts[1]!)).toEqual({ iat: NOW - 60, exp: NOW + 540, iss: '12345' });
    expect(fromBase64Url(parts[2]!)).toHaveLength(256);
    expect(await verifiesInNode(result.jwt!)).toBe(true);
  });

  it('caches the imported key per credential as a non-extractable private key', async () => {
    const first = await sign({ key: pkcs8, credentialId: 'cred-worker' });
    const second = await sign({ key: pkcs8, credentialId: 'cred-worker', now: NOW + 60 });
    expect(first.result.verified).toBe(true);
    expect(second.result.verified).toBe(true);
    const entries = second.result.cache!.filter((entry) => entry.credentialId === 'cred-worker');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'private', extractable: false });
    expect(entries[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(second.result.cache)).not.toMatch(/BEGIN|MII/);
  });

  it.each([
    ['no PEM armor', 'not a key'],
    ['garbage DER', '-----BEGIN PRIVATE KEY-----\nU0VDUkVUQk9EWUJZVEVT\n-----END PRIVATE KEY-----'],
    [
      'garbage under RSA PRIVATE KEY',
      '-----BEGIN RSA PRIVATE KEY-----\nU0VDUkVUQk9EWUJZVEVT\n-----END RSA PRIVATE KEY-----',
    ],
    ['truncated armored body', pem('PRIVATE KEY', pkcs8Der.slice(0, 300))],
  ])('rejects a malformed PEM (%s) with invalid_key', async (_name, key) => {
    const { status, result } = await sign({ key, credentialId: 'cred-bad' });
    expect(status).toBe(400);
    expect(result).toEqual({ error: 'invalid_key' });
  });
});
