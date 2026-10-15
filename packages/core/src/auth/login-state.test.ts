import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from './primitives.js';
import { LOGIN_COOKIE } from './cookies.js';
import {
  LOGIN_STATE_MAX_AGE_SECONDS,
  clearLoginState,
  openLoginState,
  safeReturnTo,
  sealLoginState,
} from './login-state.js';
import type { LoginState } from './login-state.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createKeyring } from '../secrets/keyring.js';
import type { MasterKey } from '../secrets/master-key.js';

const NOW = 1_800_000_000_000;
const CHALLENGE = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const encoder = new TextEncoder();

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

function cipherFor(...keys: MasterKey[]) {
  return createSecretCipher(createKeyring(keys), 'login-state');
}

const ONLY_V1 = (): ReturnType<typeof cipherFor> => cipherFor(masterKey(1, 0x00));
const V2_THEN_V1 = (): ReturnType<typeof cipherFor> =>
  cipherFor(masterKey(2, 0x20), masterKey(1, 0x00));

function loginState(overrides: Partial<LoginState> = {}): LoginState {
  return {
    provider: 'dex',
    purpose: 'login',
    returnTo: '/projects/a',
    issuedAt: NOW,
    sessionId: null,
    challenge: CHALLENGE,
    data: { state: 'abc', nonce: 'def', verifier: 'ghi' },
    ...overrides,
  };
}

function pair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(';'));
}

function requestWith(...cookies: string[]): Request {
  const headers = new Headers();
  for (const value of cookies) headers.append('Cookie', value);
  return new Request('https://broker.example/', { headers });
}

function valueOf(setCookie: string): string {
  return pair(setCookie).slice(`${LOGIN_COOKIE}=`.length);
}

async function sealed(
  state: LoginState = loginState(),
  cipher = ONLY_V1(),
): Promise<{ setCookie: string; request: Request }> {
  const setCookie = await sealLoginState(cipher, state);
  return { setCookie, request: requestWith(pair(setCookie)) };
}

const EXPECT_DEX = { provider: 'dex', sessionId: null } as const;

async function forgedCookie(payload: unknown, provider = 'dex'): Promise<Request> {
  const cipher = ONLY_V1();
  const box = await cipher.seal(
    encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    `login-state/${provider}/1`,
  );
  const joined = new Uint8Array(box.nonce.length + box.ciphertext.length);
  joined.set(box.nonce, 0);
  joined.set(box.ciphertext, box.nonce.length);
  return requestWith(`${LOGIN_COOKIE}=v1.1.${base64urlEncode(joined)}`);
}

describe('sealLoginState', () => {
  it('returns the full Set-Cookie string with the login cookie attributes', async () => {
    const { setCookie } = await sealed();
    expect(LOGIN_STATE_MAX_AGE_SECONDS).toBe(600);
    expect(setCookie).toMatch(/^__Host-pb_login=v1\.1\.[A-Za-z0-9_-]+; /);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).toContain('HttpOnly');
  });

  it('does not expose the plaintext state in the cookie', async () => {
    const marker = 'visible-marker-value';
    const { setCookie } = await sealed(loginState({ data: { verifier: marker } }));
    expect(setCookie).not.toContain(marker);
    expect(setCookie).not.toContain(base64urlEncode(encoder.encode(marker)));
    const body = valueOf(setCookie).split('.')[2] as string;
    const decoded = new TextDecoder('latin1').decode(base64urlDecode(body));
    expect(decoded).not.toContain(marker);
    expect(decoded).not.toContain('"provider"');
  });

  it('throws when the cipher seals under a version other than its current one', async () => {
    const real = ONLY_V1();
    const lying = {
      ...real,
      seal: async (plaintext: Uint8Array, aad: string) => ({
        ...(await real.seal(plaintext, aad)),
        keyVersion: 9,
      }),
    };
    await expect(sealLoginState(lying, loginState())).rejects.toThrow();
  });

  it('uses a fresh nonce for every seal', async () => {
    const first = await sealLoginState(ONLY_V1(), loginState());
    const second = await sealLoginState(ONLY_V1(), loginState());
    expect(first).not.toBe(second);
  });

  it('records the cipher current version in the envelope', async () => {
    const { setCookie } = await sealed(loginState(), V2_THEN_V1());
    expect(valueOf(setCookie)).toMatch(/^v1\.2\./);
  });

  it('accepts the largest state that fits in 4000 bytes and refuses one byte more', async () => {
    const cipher = ONLY_V1();
    const attempt = (padding: number): Promise<string> =>
      sealLoginState(cipher, loginState({ data: { pad: 'x'.repeat(padding) } }));
    let low = 0;
    let high = 4000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        await attempt(middle);
        low = middle;
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        high = middle - 1;
      }
    }
    const longest = await attempt(low);
    expect(encoder.encode(longest).length).toBeLessThanOrEqual(4000);
    expect(encoder.encode(longest).length).toBeGreaterThan(3996);
    await expect(attempt(low + 1)).rejects.toBeInstanceOf(RangeError);
  });

  it('throws RangeError for a state far above the cookie limit', async () => {
    await expect(
      sealLoginState(ONLY_V1(), loginState({ data: { pad: 'x'.repeat(5000) } })),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      sealLoginState(ONLY_V1(), loginState({ data: { pad: 'x'.repeat(70_000) } })),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects malformed states with a TypeError', async () => {
    const cipher = ONLY_V1();
    const bad: Partial<LoginState>[] = [
      { provider: '' },
      { provider: 'a/b' },
      { provider: 'Dex' },
      { purpose: 'other' as 'login' },
      { returnTo: '//evil.example' },
      { returnTo: '/a\\b' },
      { issuedAt: Number.NaN },
      { issuedAt: 1.5 },
      { challenge: 'short' },
      { challenge: `${CHALLENGE}=` },
      { purpose: 'reauth', sessionId: null },
      { data: { key: 1 } as unknown as Record<string, string> },
    ];
    for (const overrides of bad) {
      await expect(sealLoginState(cipher, loginState(overrides))).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe('openLoginState', () => {
  it('round-trips a state for the same provider within 10 minutes', async () => {
    const { request } = await sealed();
    const opened = await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW + 599_000);
    expect(opened).toEqual(loginState());
  });

  it('opens at exactly 600 seconds and at 60 seconds in the future', async () => {
    const { request } = await sealed();
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW + 600_000)).not.toBeNull();
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW - 60_000)).not.toBeNull();
  });

  it('opens a state sealed under ring [v1] with ring [v2, v1]', async () => {
    const { request } = await sealed(loginState(), ONLY_V1());
    const opened = await openLoginState(V2_THEN_V1(), request, EXPECT_DEX, NOW + 1000);
    expect(opened).toEqual(loginState());
  });

  it('opens a state sealed under the current version of a rotated ring', async () => {
    const { request } = await sealed(loginState(), V2_THEN_V1());
    expect(await openLoginState(V2_THEN_V1(), request, EXPECT_DEX, NOW)).toEqual(loginState());
  });

  it('returns null for an unloaded key version', async () => {
    const { request } = await sealed(loginState(), V2_THEN_V1());
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW)).toBeNull();
  });

  it('returns null when the envelope version is rewritten to another loaded version', async () => {
    const { setCookie } = await sealed(loginState(), V2_THEN_V1());
    const rewritten = pair(setCookie).replace('=v1.2.', '=v1.1.');
    expect(rewritten).not.toBe(pair(setCookie));
    expect(await openLoginState(V2_THEN_V1(), requestWith(rewritten), EXPECT_DEX, NOW)).toBeNull();
  });

  it('returns null for another provider', async () => {
    const { request } = await sealed();
    expect(
      await openLoginState(ONLY_V1(), request, { provider: 'other', sessionId: null }, NOW),
    ).toBeNull();
  });

  it('returns null for a payload whose provider differs from the expected one', async () => {
    const request = await forgedCookie({ ...loginState(), provider: 'other' });
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW)).toBeNull();
  });

  it('returns null 601 seconds later and 61 seconds before issue', async () => {
    const { request } = await sealed();
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW + 601_000)).toBeNull();
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW - 61_000)).toBeNull();
  });

  it('returns null unless nowMs is a safe integer', async () => {
    const { request } = await sealed();
    const bad = [Number.NaN, Infinity, -Infinity, undefined, '1800000000000', null, NOW + 0.5];
    for (const nowMs of bad) {
      expect(
        await openLoginState(ONLY_V1(), request, EXPECT_DEX, nowMs as unknown as number),
      ).toBeNull();
    }
  });

  it('returns null when the cookie is missing', async () => {
    expect(await openLoginState(ONLY_V1(), requestWith(), EXPECT_DEX, NOW)).toBeNull();
    expect(
      await openLoginState(ONLY_V1(), requestWith('__Host-pb_session=abc'), EXPECT_DEX, NOW),
    ).toBeNull();
  });

  it('returns null when a character of the value is flipped', async () => {
    const { setCookie } = await sealed();
    const value = valueOf(setCookie);
    const index = value.length - 5;
    const flipped =
      value.slice(0, index) + (value[index] === 'A' ? 'B' : 'A') + value.slice(index + 1);
    const request = requestWith(`${LOGIN_COOKIE}=${flipped}`);
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW)).toBeNull();
  });

  it('returns null when the cookie is duplicated', async () => {
    const { setCookie } = await sealed();
    const request = requestWith(pair(setCookie), pair(setCookie));
    expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW)).toBeNull();
  });

  it('returns null for malformed envelopes', async () => {
    const { setCookie } = await sealed();
    const [, , body] = valueOf(setCookie).split('.') as [string, string, string];
    const malformed = [
      'v2.1.' + body,
      'v1.1',
      'v1.' + body,
      'v1.1.' + body + '.extra',
      'v1..' + body,
      'v1.01.' + body,
      'v1.0.' + body,
      'v1.1.',
      'v1.1.AAAA',
      'v1.1.' + 'A'.repeat(39),
      'v1.99999999999999999999.' + body,
      'x'.repeat(10),
    ];
    for (const value of malformed) {
      const request = requestWith(`${LOGIN_COOKIE}=${value}`);
      expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW)).toBeNull();
    }
  });

  it('returns null for authenticated payloads that are not a valid state', async () => {
    const valid = loginState();
    const forged: unknown[] = [
      'not json',
      '[]',
      'null',
      { ...valid, challenge: 'short' },
      { ...valid, purpose: 'other' },
      { ...valid, returnTo: '//evil.example' },
      { ...valid, issuedAt: '1800000000000' },
      { ...valid, sessionId: 7 },
      { ...valid, data: { key: 1 } },
      { ...valid, data: ['x'] },
      { ...valid, data: null },
      { ...valid, provider: undefined },
    ];
    for (const payload of forged) {
      const request = await forgedCookie(payload);
      expect(await openLoginState(ONLY_V1(), request, EXPECT_DEX, NOW)).toBeNull();
    }
    expect(await openLoginState(ONLY_V1(), await forgedCookie(valid), EXPECT_DEX, NOW)).toEqual(
      valid,
    );
  });

  describe('re-authentication', () => {
    const reauth = (): LoginState => loginState({ purpose: 'reauth', sessionId: 'session-one' });

    it('opens for the initiating session', async () => {
      const { request } = await sealed(reauth());
      const opened = await openLoginState(
        ONLY_V1(),
        request,
        { provider: 'dex', sessionId: 'session-one' },
        NOW,
      );
      expect(opened).toEqual(reauth());
    });

    it('returns null for another session id or none', async () => {
      const { request } = await sealed(reauth());
      for (const sessionId of ['session-two', null]) {
        expect(
          await openLoginState(ONLY_V1(), request, { provider: 'dex', sessionId }, NOW),
        ).toBeNull();
      }
    });

    it('ignores the current session for a login state', async () => {
      const { request } = await sealed();
      const opened = await openLoginState(
        ONLY_V1(),
        request,
        { provider: 'dex', sessionId: 'any-session' },
        NOW,
      );
      expect(opened).toEqual(loginState());
    });
  });
});

describe('clearLoginState', () => {
  it('expires the login cookie with the same attributes', () => {
    expect(clearLoginState()).toBe(
      '__Host-pb_login=; Path=/; Secure; SameSite=Lax; Max-Age=0; HttpOnly',
    );
  });
});

describe('safeReturnTo', () => {
  it('keeps same-origin paths, including percent-encoded slashes', () => {
    expect(safeReturnTo('/projects/a')).toBe('/projects/a');
    expect(safeReturnTo('/%2F%2Fevil')).toBe('/%2F%2Fevil');
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/a?b=c#d')).toBe('/a?b=c#d');
  });

  it('falls back to / for anything else', () => {
    const rejected = [
      null,
      '',
      '//evil.example',
      '/\\evil',
      '/a\\b',
      'https://evil.example',
      'javascript:x',
      'projects/a',
      '/a\nb',
      '/a\rb',
      '/a\u0000b',
      '/a\u007fb',
      '/a\u0085b',
      '/a\tb',
    ];
    for (const raw of rejected) {
      expect(safeReturnTo(raw)).toBe('/');
    }
  });

  it('returns / for non-string input', () => {
    for (const raw of [[], ['/a'], {}, { toString: () => '/a' }, 7, undefined, true]) {
      expect(safeReturnTo(raw as unknown as string)).toBe('/');
    }
  });

  it('returns / for empty path segments and dot segments, including encoded forms', () => {
    const rejected = [
      '/.//evil.example',
      '/..//evil.example',
      '/%2e%2e//evil',
      '/a//b',
      '/a/./b',
      '/a/../b',
      '/a/%2e/b',
      '/a/%2E%2E/b',
      '/a/.%2e/b',
      '/a/%2e./b',
      '/..',
      '/.',
      '/a/..?x=1',
    ];
    for (const raw of rejected) {
      expect(safeReturnTo(raw)).toBe('/');
    }
  });

  it('returns / for anything but printable ASCII', () => {
    for (const raw of ['/中', '/a b', '/é', '/a\u00a0b', '/a\u{1F600}', '/a\ud800b']) {
      expect(safeReturnTo(raw)).toBe('/');
    }
  });

  it('keeps encoded backslashes, dots inside names and query strings', () => {
    const kept = [
      '/%5Cevil',
      '/a.b/c..d',
      '/.well-known/x',
      '/a/...',
      '/projects/a?tab=1&x=a.b',
      '/projects/a?next=%2Fb#frag',
      '/a/b/',
    ];
    for (const raw of kept) {
      expect(safeReturnTo(raw)).toBe(raw);
    }
  });

  it('accepts 512 characters and rejects 513', () => {
    const path512 = '/' + 'a'.repeat(511);
    expect(safeReturnTo(path512)).toBe(path512);
    expect(safeReturnTo(path512 + 'a')).toBe('/');
  });
});
