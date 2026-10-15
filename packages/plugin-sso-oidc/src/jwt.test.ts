import { base64urlDecode, base64urlEncode } from '@package-broker/core/auth/primitives';
import type { Clock } from '@package-broker/core/ids';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CryptoKey, JwtError, type JwtFailure, type KeySource, verifyJwt } from './jwt.js';

const NOW = 1_800_000_000;
const ISSUER = 'https://team.example.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const KID = 'key-1';
const encoder = new TextEncoder();

const clock: Clock = { now: () => new Date(NOW * 1000) };

interface Signer {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

let signer: Signer;
let otherSigner: Signer;

async function generate(modulusLength = 2048, hash = 'SHA-256'): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash,
    },
    true,
    ['sign', 'verify'],
  );
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

beforeAll(async () => {
  signer = await generate();
  otherSigner = await generate();
});

function validPayload(): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'user-1',
    aud: [AUDIENCE],
    exp: NOW + 300,
    iat: NOW - 10,
    email: 'someone@example.test',
  };
}

function segment(value: unknown): string {
  return base64urlEncode(encoder.encode(JSON.stringify(value)));
}

async function sign(
  payload: unknown,
  options: { header?: Record<string, unknown>; key?: CryptoKey } = {},
): Promise<string> {
  const header = options.header ?? { alg: 'RS256', typ: 'JWT', kid: KID };
  const signingInput = `${segment(header)}.${segment(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    options.key ?? signer.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

interface CountingKeys extends KeySource {
  readonly calls: string[];
}

function keysFor(key: () => CryptoKey): CountingKeys {
  const calls: string[] = [];
  return {
    calls,
    getKey: async (kid) => {
      calls.push(kid);
      if (kid !== KID) {
        throw new JwtError('unknown_kid');
      }
      return key();
    },
  };
}

async function verify(token: string, keys: KeySource = keysFor(() => signer.publicKey)) {
  return verifyJwt(token, { keys, issuer: ISSUER, audience: AUDIENCE, clock });
}

async function failureOf(promise: Promise<unknown>): Promise<JwtFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JwtError);
    return (error as JwtError).failure;
  }
  throw new Error('expected verification to fail');
}

function decodeUtf8(segment: string): string {
  return new TextDecoder().decode(base64urlDecode(segment));
}

function tryDecodeJson(segment: string): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(base64urlDecode(segment));
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? text : null;
  } catch {
    return null;
  }
}

function tokenOfLength(length: number): string {
  const header = segment({ alg: 'RS256', typ: 'JWT', kid: KID });
  for (let padding = 0; padding < 20_000; padding += 1) {
    const payload = segment({ ...validPayload(), padding: 'x'.repeat(padding) });
    const remaining = length - header.length - payload.length - 2;
    if (remaining >= 256 && remaining < 400) {
      for (let bytes = 1; bytes < 300; bytes += 1) {
        const signature = base64urlEncode(new Uint8Array(bytes));
        if (signature.length === remaining) {
          return `${header}.${payload}.${signature}`;
        }
      }
    }
  }
  throw new Error('no token of that length');
}

describe('verifyJwt', () => {
  it('returns typed claims for a valid token', async () => {
    const keys = keysFor(() => signer.publicKey);
    const claims = await verify(
      await sign({ ...validPayload(), nbf: NOW - 5, auth_time: NOW - 20 }),
      keys,
    );
    expect(keys.calls).toEqual([KID]);
    expect(Object.isFrozen(claims.raw)).toBe(true);
    expect(Object.isFrozen(claims.aud)).toBe(true);
    expect(Object.getPrototypeOf(claims.raw)).toBeNull();
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: 'user-1',
      aud: [AUDIENCE],
      exp: NOW + 300,
      iat: NOW - 10,
      nbf: NOW - 5,
      authTime: NOW - 20,
    });
    expect(claims.raw.email).toBe('someone@example.test');
  });

  it('normalises a string aud and reports absent optional claims as null', async () => {
    const claims = await verify(await sign({ ...validPayload(), aud: AUDIENCE }));
    expect(claims.aud).toEqual([AUDIENCE]);
    expect(claims.nbf).toBeNull();
    expect(claims.authTime).toBeNull();
  });

  it('accepts an aud array that contains the audience among others', async () => {
    const claims = await verify(await sign({ ...validPayload(), aud: ['other', AUDIENCE] }));
    expect(claims.aud).toEqual(['other', AUDIENCE]);
  });

  it('allows exactly the skew on exp, nbf, iat and auth_time boundaries', async () => {
    const claims = await verify(
      await sign({
        ...validPayload(),
        exp: NOW - 59,
        nbf: NOW + 60,
        iat: NOW + 60,
        auth_time: NOW + 60,
      }),
    );
    expect(claims.nbf).toBe(NOW + 60);
  });

  it('honours a custom skew', async () => {
    const token = await sign({ ...validPayload(), exp: NOW - 61 });
    const keys = keysFor(() => signer.publicKey);
    await expect(
      verifyJwt(token, { keys, issuer: ISSUER, audience: AUDIENCE, clock, skewSeconds: 120 }),
    ).resolves.toMatchObject({ exp: NOW - 61 });
  });

  it('rejects alg none with an empty signature before any key lookup', async () => {
    const keys = keysFor(() => signer.publicKey);
    const token = `${segment({ alg: 'none', typ: 'JWT', kid: KID })}.${segment(validPayload())}.`;
    expect(await failureOf(verify(token, keys))).toBe('unsupported_alg');
    expect(keys.calls).toEqual([]);
  });

  it('rejects HS256 signed with the public key bytes as the HMAC secret', async () => {
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', signer.publicKey));
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      spki,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signingInput = `${segment({ alg: 'HS256', typ: 'JWT', kid: KID })}.${segment(validPayload())}`;
    const mac = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(signingInput));
    const token = `${signingInput}.${base64urlEncode(new Uint8Array(mac))}`;
    const keys = keysFor(() => signer.publicKey);
    expect(await failureOf(verify(token, keys))).toBe('unsupported_alg');
    expect(keys.calls).toEqual([]);
  });

  it.each(['rs256', 'RS384', 'PS256', 'ES256', '', 5, null])(
    'rejects alg %j without calling the key source',
    async (alg) => {
      const keys = keysFor(() => signer.publicKey);
      const token = await sign(validPayload(), { header: { alg, kid: KID } });
      expect(await failureOf(verify(token, keys))).toBe('unsupported_alg');
      expect(keys.calls).toEqual([]);
    },
  );

  it('rejects a header without alg', async () => {
    const keys = keysFor(() => signer.publicKey);
    const token = await sign(validPayload(), { header: { kid: KID } });
    expect(await failureOf(verify(token, keys))).toBe('unsupported_alg');
    expect(keys.calls).toEqual([]);
  });

  it.each([
    ['missing', { alg: 'RS256' }],
    ['empty', { alg: 'RS256', kid: '' }],
    ['numeric', { alg: 'RS256', kid: 1 }],
  ])('rejects a %s kid as malformed without a key lookup', async (_name, header) => {
    const keys = keysFor(() => signer.publicKey);
    const token = await sign(validPayload(), { header });
    expect(await failureOf(verify(token, keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it.each([
    ['crit array', { alg: 'RS256', kid: KID, crit: ['exp'] }],
    ['empty crit array', { alg: 'RS256', kid: KID, crit: [] }],
    ['crit null', { alg: 'RS256', kid: KID, crit: null }],
    ['crit string', { alg: 'RS256', kid: KID, crit: 'b64' }],
  ])('rejects a header with %s as malformed', async (_name, header) => {
    const keys = keysFor(() => signer.publicKey);
    expect(await failureOf(verify(await sign(validPayload(), { header }), keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it.each(['jwt', 'JWT', 'Jwt'])('accepts typ %s', async (typ) => {
    const token = await sign(validPayload(), { header: { alg: 'RS256', kid: KID, typ } });
    await expect(verify(token)).resolves.toMatchObject({ sub: 'user-1' });
  });

  it.each([
    ['at+jwt', 'at+jwt'],
    ['JOSE', 'JOSE'],
    ['empty', ''],
    ['number', 5],
    ['null', null],
  ])('rejects typ %s as malformed', async (_name, typ) => {
    const keys = keysFor(() => signer.publicKey);
    const token = await sign(validPayload(), { header: { alg: 'RS256', kid: KID, typ } });
    expect(await failureOf(verify(token, keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it.each([
    ['with a space', 'key 1'],
    ['with a newline', 'key\n1'],
    ['non-ASCII', 'kluc\u00e9'],
    ['longer than 256 characters', 'k'.repeat(257)],
  ])('rejects a kid %s as malformed', async (_name, kid) => {
    const keys = keysFor(() => signer.publicKey);
    const token = await sign(validPayload(), { header: { alg: 'RS256', kid } });
    expect(await failureOf(verify(token, keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it('accepts a kid of 256 printable ASCII characters', async () => {
    const kid = 'k'.repeat(256);
    const keys: KeySource = { getKey: async () => signer.publicKey };
    const token = await sign(validPayload(), { header: { alg: 'RS256', kid } });
    await expect(verify(token, keys)).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('rejects a non-string token as malformed', async () => {
    for (const token of [undefined, null, 5, {}, ['a.b.c']]) {
      expect(await failureOf(verify(token as unknown as string))).toBe('malformed');
    }
  });

  it('rejects a payload with an own __proto__ key as malformed', async () => {
    const [header] = (await sign(validPayload())).split('.') as [string];
    const raw = JSON.stringify(validPayload()).replace('{', '{"__proto__":{"admin":true},');
    expect(await failureOf(verify(await resign(header, raw)))).toBe('malformed');
  });

  it('keeps duplicate JSON keys last-wins because the signature covers the bytes', async () => {
    const [header] = (await sign(validPayload())).split('.') as [string];
    const raw = JSON.stringify(validPayload()).replace(
      '"sub":"user-1"',
      '"sub":"first","sub":"user-1"',
    );
    expect(raw).toContain('"first"');
    await expect(verify(await resign(header, raw))).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('exposes azp and nonce as optional strings', async () => {
    const claims = await verify(await sign({ ...validPayload(), azp: 'client', nonce: 'n-1' }));
    expect(claims.azp).toBe('client');
    expect(claims.nonce).toBe('n-1');
    const bare = await verify(await sign(validPayload()));
    expect('azp' in bare).toBe(false);
    expect('nonce' in bare).toBe(false);
    const wrongTypes = await verify(await sign({ ...validPayload(), azp: 5, nonce: ['n'] }));
    expect('azp' in wrongTypes).toBe(false);
    expect('nonce' in wrongTypes).toBe(false);
  });

  it('rejects an unknown kid', async () => {
    const token = await sign(validPayload(), { header: { alg: 'RS256', kid: 'other' } });
    expect(await failureOf(verify(token))).toBe('unknown_kid');
  });

  it('surfaces jwks_unavailable from the key source', async () => {
    const keys: KeySource = {
      getKey: async () => {
        throw new JwtError('jwks_unavailable');
      },
    };
    expect(await failureOf(verify(await sign(validPayload()), keys))).toBe('jwks_unavailable');
  });

  it('maps an unexpected key source error to jwks_unavailable', async () => {
    const keys: KeySource = {
      getKey: async () => {
        throw new TypeError('network down');
      },
    };
    expect(await failureOf(verify(await sign(validPayload()), keys))).toBe('jwks_unavailable');
  });

  it.each(['bad_claim', 'bad_signature', 'malformed', 'expired'] as const)(
    'maps a %s JwtError from the key source to jwks_unavailable',
    async (failure) => {
      const keys: KeySource = {
        getKey: async () => {
          throw new JwtError(failure);
        },
      };
      expect(await failureOf(verify(await sign(validPayload()), keys))).toBe('jwks_unavailable');
    },
  );

  it('rejects one flipped character in the encoded payload', async () => {
    const [header, payload, signature] = (await sign(validPayload())).split('.') as [
      string,
      string,
      string,
    ];
    const original = decodeUtf8(payload);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let flipped: string | undefined;
    for (
      let index = Math.floor(payload.length / 2);
      index < payload.length - 2 && !flipped;
      index += 1
    ) {
      for (const candidate of alphabet) {
        const attempt = payload.slice(0, index) + candidate + payload.slice(index + 1);
        const text = tryDecodeJson(attempt);
        if (candidate !== payload[index] && text !== null && text !== original) {
          flipped = attempt;
          break;
        }
      }
    }
    expect(flipped).toBeDefined();
    expect(await failureOf(verify(`${header}.${flipped}.${signature}`))).toBe('bad_signature');
  });

  it('rejects one flipped character in the signature', async () => {
    const [header, payload, signature] = (await sign(validPayload())).split('.') as [
      string,
      string,
      string,
    ];
    const middle = Math.floor(signature.length / 2);
    const swapped = signature[middle] === 'A' ? 'B' : 'A';
    const forged = signature.slice(0, middle) + swapped + signature.slice(middle + 1);
    expect(await failureOf(verify(`${header}.${payload}.${forged}`))).toBe('bad_signature');
  });

  it('rejects a flipped payload byte', async () => {
    const token = await sign(validPayload());
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const tampered = JSON.stringify(validPayload()).replace('user-1', 'user-2');
    const forged = `${header}.${base64urlEncode(encoder.encode(tampered))}.${signature}`;
    expect(payload).not.toBe(base64urlEncode(encoder.encode(tampered)));
    expect(await failureOf(verify(forged))).toBe('bad_signature');
  });

  it('rejects a signature from a different key', async () => {
    const token = await sign(validPayload(), { key: otherSigner.privateKey });
    expect(await failureOf(verify(token))).toBe('bad_signature');
  });

  it('rejects an empty or truncated signature', async () => {
    const token = await sign(validPayload());
    const [header, payload, signature] = token.split('.') as [string, string, string];
    expect(await failureOf(verify(`${header}.${payload}.`))).toBe('bad_signature');
    expect(await failureOf(verify(`${header}.${payload}.${signature.slice(0, 40)}`))).toBe(
      'bad_signature',
    );
  });

  it('fails closed with jwks_unavailable for a key that is not an RS256 verification key', async () => {
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'verify',
    ]);
    expect(
      await failureOf(
        verify(
          await sign(validPayload()),
          keysFor(() => hmac),
        ),
      ),
    ).toBe('jwks_unavailable');
  });

  it.each(['SHA-1', 'SHA-384', 'SHA-512'])(
    'rejects a %s key even with a matching signature labelled RS256',
    async (hash) => {
      const weak = await generate(2048, hash);
      const token = await sign(validPayload(), { key: weak.privateKey });
      expect(
        await failureOf(
          verify(
            token,
            keysFor(() => weak.publicKey),
          ),
        ),
      ).toBe('jwks_unavailable');
    },
  );

  it('rejects a 1024-bit key with a matching signature', async () => {
    const small = await generate(1024);
    const token = await sign(validPayload(), { key: small.privateKey });
    expect(
      await failureOf(
        verify(
          token,
          keysFor(() => small.publicKey),
        ),
      ),
    ).toBe('jwks_unavailable');
  });

  it('rejects a private key handed out by the key source', async () => {
    const token = await sign(validPayload());
    expect(
      await failureOf(
        verify(
          token,
          keysFor(() => signer.privateKey),
        ),
      ),
    ).toBe('jwks_unavailable');
  });

  it('rejects a public key without the verify usage', async () => {
    const spki = await crypto.subtle.exportKey('spki', signer.publicKey);
    const noUsage = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      [],
    );
    expect(
      await failureOf(
        verify(
          await sign(validPayload()),
          keysFor(() => noUsage),
        ),
      ),
    ).toBe('jwks_unavailable');
  });

  it('maps a throw from crypto.subtle.verify to jwks_unavailable', async () => {
    const broken = {
      type: 'public',
      usages: ['verify'],
      algorithm: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: { name: 'SHA-256' } },
    } as unknown as CryptoKey;
    expect(
      await failureOf(
        verify(
          await sign(validPayload()),
          keysFor(() => broken),
        ),
      ),
    ).toBe('jwks_unavailable');
  });

  it('rejects a wrong issuer, including a non-string iss', async () => {
    expect(await failureOf(verify(await sign({ ...validPayload(), iss: `${ISSUER}/` })))).toBe(
      'wrong_issuer',
    );
    expect(await failureOf(verify(await sign({ ...validPayload(), iss: 5 })))).toBe('wrong_issuer');
    const withoutIss = validPayload();
    delete withoutIss.iss;
    expect(await failureOf(verify(await sign(withoutIss)))).toBe('wrong_issuer');
  });

  it.each([
    ['mismatching string', 'other'],
    ['mismatching array', ['other']],
    ['array with a number', [5]],
    ['array mixing a number and the audience', [AUDIENCE, 5]],
    ['empty array', []],
    ['number', 5],
    ['null', null],
    ['object', { [AUDIENCE]: true }],
  ])('rejects aud: %s', async (_name, aud) => {
    expect(await failureOf(verify(await sign({ ...validPayload(), aud })))).toBe('wrong_audience');
  });

  it('rejects a missing aud', async () => {
    const withoutAud = validPayload();
    delete withoutAud.aud;
    expect(await failureOf(verify(await sign(withoutAud)))).toBe('wrong_audience');
  });

  it('rejects a token expired by 61 seconds', async () => {
    expect(await failureOf(verify(await sign({ ...validPayload(), exp: NOW - 61 })))).toBe(
      'expired',
    );
  });

  it('rejects exp exactly at now minus skew', async () => {
    expect(await failureOf(verify(await sign({ ...validPayload(), exp: NOW - 60 })))).toBe(
      'expired',
    );
  });

  it('rejects nbf 61 seconds ahead', async () => {
    expect(await failureOf(verify(await sign({ ...validPayload(), nbf: NOW + 61 })))).toBe(
      'not_yet_valid',
    );
  });

  it('rejects iat 61 seconds ahead', async () => {
    expect(await failureOf(verify(await sign({ ...validPayload(), iat: NOW + 61 })))).toBe(
      'issued_in_future',
    );
  });

  it('rejects auth_time 61 seconds ahead', async () => {
    expect(await failureOf(verify(await sign({ ...validPayload(), auth_time: NOW + 61 })))).toBe(
      'issued_in_future',
    );
  });

  it.each([
    ['exp string', { exp: '1' }],
    ['exp 1e300', { exp: 1e300 }],
    ['exp negative huge', { exp: -1e300 }],
    ['exp more than ten years ahead', { exp: NOW + 315_360_001 }],
    ['exp null', { exp: null }],
    ['iat string', { iat: String(NOW) }],
    ['iat more than ten years back', { iat: NOW - 315_360_001 }],
    ['nbf string', { nbf: '1' }],
    ['nbf 1e300', { nbf: 1e300 }],
    ['auth_time string', { auth_time: '1' }],
    ['auth_time 1e300', { auth_time: 1e300 }],
  ])('rejects %s as bad_claim', async (_name, override) => {
    expect(await failureOf(verify(await sign({ ...validPayload(), ...override })))).toBe(
      'bad_claim',
    );
  });

  it.each(['exp', 'iat'])('rejects a missing %s as bad_claim', async (claim) => {
    const payload = validPayload();
    delete payload[claim];
    expect(await failureOf(verify(await sign(payload)))).toBe('bad_claim');
  });

  it('rejects a number that parses to Infinity as bad_claim', async () => {
    const [header] = (await sign(validPayload())).split('.') as [string];
    const raw = JSON.stringify(validPayload()).replace(`"exp":${NOW + 300}`, '"exp":1e999');
    expect(raw).toContain('1e999');
    expect(await failureOf(verify(await resign(header, raw)))).toBe('bad_claim');
  });

  it('rejects a missing sub as bad_claim', async () => {
    const withoutSub = validPayload();
    delete withoutSub.sub;
    expect(await failureOf(verify(await sign(withoutSub)))).toBe('bad_claim');
  });

  it.each([
    ['empty', ''],
    ['number', 5],
    ['null', null],
    ['array', ['user-1']],
    ['256 characters', 'u'.repeat(256)],
    ['control character', 'user\u0000-1'],
  ])('rejects sub: %s as bad_claim', async (_name, sub) => {
    expect(await failureOf(verify(await sign({ ...validPayload(), sub })))).toBe('bad_claim');
  });

  it('accepts a 255 character sub', async () => {
    const claims = await verify(await sign({ ...validPayload(), sub: 'u'.repeat(255) }));
    expect(claims.sub).toHaveLength(255);
  });

  it('treats exactly 16384 characters as within the limit and 16385 as malformed', async () => {
    const atLimit = tokenOfLength(16_384);
    const overLimit = tokenOfLength(16_385);
    expect(atLimit).toHaveLength(16_384);
    expect(overLimit).toHaveLength(16_385);
    const keys = keysFor(() => signer.publicKey);
    expect(await failureOf(verify(atLimit, keys))).toBe('bad_signature');
    expect(keys.calls).toEqual([KID]);
    const refused = keysFor(() => signer.publicKey);
    expect(await failureOf(verify(overLimit, refused))).toBe('malformed');
    expect(refused.calls).toEqual([]);
  });

  it('rejects a validly signed token larger than 16 KiB without a key lookup', async () => {
    const keys = keysFor(() => signer.publicKey);
    const token = await sign({ ...validPayload(), padding: 'x'.repeat(17 * 1024) });
    expect(token.length).toBeGreaterThan(16 * 1024);
    expect(await failureOf(verify(token, keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it('accepts a token just under 16 KiB', async () => {
    const token = await sign({ ...validPayload(), padding: 'x'.repeat(9 * 1024) });
    expect(token.length).toBeLessThanOrEqual(16 * 1024);
    await expect(verify(token)).resolves.toMatchObject({ sub: 'user-1' });
  });

  it.each([
    ['empty', ''],
    ['one part', 'abc'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['not base64url', '!!!.???.***'],
    ['padded base64', 'YQ==.YQ==.YQ=='],
  ])('rejects %s as malformed', async (_name, token) => {
    const keys = keysFor(() => signer.publicKey);
    expect(await failureOf(verify(token, keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it.each([
    ['header is an array', '[]', '{}'],
    ['header is null', 'null', '{}'],
    ['header is not JSON', 'nope', '{}'],
    ['payload is an array', '{"alg":"RS256","kid":"key-1"}', '[]'],
    ['payload is a string', '{"alg":"RS256","kid":"key-1"}', '"text"'],
    ['payload is not JSON', '{"alg":"RS256","kid":"key-1"}', 'nope'],
  ])('rejects a token where %s as malformed', async (_name, header, payload) => {
    const keys = keysFor(() => signer.publicKey);
    const token = `${base64urlEncode(encoder.encode(header))}.${base64urlEncode(encoder.encode(payload))}.${base64urlEncode(new Uint8Array(256))}`;
    expect(await failureOf(verify(token, keys))).toBe('malformed');
    expect(keys.calls).toEqual([]);
  });

  it('rejects invalid UTF-8 in the header as malformed', async () => {
    const header = base64urlEncode(new Uint8Array([0x7b, 0xff, 0x7d]));
    const token = `${header}.${segment(validPayload())}.${base64urlEncode(new Uint8Array(256))}`;
    expect(await failureOf(verify(token))).toBe('malformed');
  });

  it.each([
    ['issuer', { issuer: '' }],
    ['audience', { audience: '' }],
  ])('rejects an empty configured %s', async (_name, override) => {
    await expect(
      verifyJwt(await sign(validPayload()), {
        keys: keysFor(() => signer.publicKey),
        issuer: ISSUER,
        audience: AUDIENCE,
        clock,
        ...override,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a negative skew', async () => {
    await expect(
      verifyJwt(await sign(validPayload()), {
        keys: keysFor(() => signer.publicKey),
        issuer: ISSUER,
        audience: AUDIENCE,
        clock,
        skewSeconds: -1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('JwtError', () => {
  it('carries the failure kind and never a message with token data', () => {
    const error = new JwtError('bad_claim');
    expect(error).toBeInstanceOf(Error);
    expect(error.failure).toBe('bad_claim');
    expect(error.name).toBe('JwtError');
    expect(error.message).toBe('bad_claim');
  });
});

async function resign(encodedHeader: string, rawPayload: string): Promise<string> {
  const signingInput = `${encodedHeader}.${base64urlEncode(encoder.encode(rawPayload))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signer.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}
