import { describe, expect, it } from 'vitest';
import { CsrfError, UNSAFE_METHODS, assertCsrfToken, assertSameOrigin } from './csrf.js';
import type { CsrfReason } from './csrf.js';
import { randomToken, sha256Hex } from './primitives.js';

const ORIGIN = 'https://broker.example.test';

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/_pb/auth/logout`, { method, headers });
}

function reasonOf(action: () => void): CsrfReason | null {
  try {
    action();
  } catch (error) {
    if (error instanceof CsrfError) {
      return error.reason;
    }
    throw error;
  }
  return null;
}

async function tokenReasonOf(action: () => Promise<void>): Promise<CsrfReason | null> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CsrfError) {
      return error.reason;
    }
    throw error;
  }
  return null;
}

describe('UNSAFE_METHODS', () => {
  it('lists exactly POST PUT PATCH DELETE', () => {
    expect([...UNSAFE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
  });
});

describe('CsrfError', () => {
  it('carries the reason', () => {
    const error = new CsrfError('token_missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('token_missing');
  });
});

describe('assertSameOrigin', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('is a no-op for %s even when cross-site', (method) => {
    const cross = request(method, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' });
    expect(reasonOf(() => assertSameOrigin(cross, ORIGIN))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('checks %s', (method) => {
    expect(reasonOf(() => assertSameOrigin(request(method), ORIGIN))).toBe('origin_missing');
  });

  it('accepts same-origin fetch metadata without Origin', () => {
    const req = request('POST', { 'sec-fetch-site': 'same-origin' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBeNull();
  });

  it('accepts Sec-Fetch-Site none', () => {
    const req = request('POST', { 'sec-fetch-site': 'none' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBeNull();
  });

  it.each(['cross-site', 'same-site'])('refuses Sec-Fetch-Site %s', (site) => {
    const req = request('POST', { 'sec-fetch-site': site });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('cross_site');
  });

  it('refuses an unknown Sec-Fetch-Site value', () => {
    const req = request('POST', { 'sec-fetch-site': 'bogus' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('cross_site');
  });

  it('refuses a foreign Origin even when Sec-Fetch-Site says same-origin', () => {
    const req = request('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://evil.test' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });

  it('refuses a foreign Origin together with cross-site as origin_mismatch', () => {
    const req = request('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });

  it('refuses a matching Origin with cross-site fetch metadata', () => {
    const req = request('POST', { 'sec-fetch-site': 'cross-site', origin: ORIGIN });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('cross_site');
  });

  it('accepts a matching Origin without fetch metadata', () => {
    const req = request('POST', { origin: ORIGIN });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBeNull();
  });

  it('accepts a matching Origin with same-origin fetch metadata', () => {
    const req = request('POST', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBeNull();
  });

  it('refuses a foreign Origin without fetch metadata', () => {
    const req = request('POST', { origin: 'https://evil.test' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });

  it('refuses Origin null', () => {
    const req = request('POST', { origin: 'null' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });

  it('compares the Origin exactly', () => {
    for (const origin of [
      `${ORIGIN}/`,
      'http://broker.example.test',
      'https://broker.example.test:8443',
      'https://BROKER.example.test',
      'https://broker.example.test.evil.test',
    ]) {
      const req = request('POST', { origin });
      expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
    }
  });

  it('refuses an empty Origin header', () => {
    const req = request('POST', { origin: '' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });

  it('refuses an empty Sec-Fetch-Site header', () => {
    const req = request('POST', { 'sec-fetch-site': '' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('cross_site');
  });
});

describe('assertSameOrigin fail-closed methods', () => {
  it.each(['PROPFIND', 'patch', 'put', 'delete', 'post'])('checks %s', (method) => {
    const req = request(method, { origin: 'https://evil.test' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
    expect(reasonOf(() => assertSameOrigin(request(method), ORIGIN))).toBe('origin_missing');
  });

  it.each(['get', 'head', 'options'])('skips lowercase %s', (method) => {
    const req = request(method, { origin: 'https://evil.test' });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBeNull();
  });
});

describe('assertSameOrigin publicOrigin validation', () => {
  it.each([
    ['empty', ''],
    ['null', 'null'],
    ['trailing slash', 'https://broker.example.test/'],
    ['path', 'https://broker.example.test/app'],
    ['uppercase host', 'https://BROKER.example.test'],
    ['explicit default port', 'https://broker.example.test:443'],
    ['unicode host', 'https://bücher.example.test'],
    ['no scheme', 'broker.example.test'],
  ])('throws TypeError for %s', (_name, publicOrigin) => {
    const req = request('POST', { origin: ORIGIN });
    expect(() => assertSameOrigin(req, publicOrigin)).toThrow(TypeError);
    expect(() => assertSameOrigin(request('GET'), publicOrigin)).toThrow(TypeError);
  });

  it('accepts canonical origins with a non-default port and http loopback', () => {
    for (const publicOrigin of ['https://broker.example.test:8443', 'http://127.0.0.1:8787']) {
      const req = request('POST', { origin: publicOrigin });
      expect(reasonOf(() => assertSameOrigin(req, publicOrigin))).toBeNull();
    }
  });
});

describe('repeated headers', () => {
  function repeated(name: string, first: string, second: string): Request {
    const headers = new Headers();
    headers.append(name, first);
    headers.append(name, second);
    return new Request(`${ORIGIN}/_pb/auth/logout`, { method: 'POST', headers });
  }

  it('refuses two Origin values, even when both match', () => {
    const req = repeated('origin', ORIGIN, ORIGIN);
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });

  it('refuses two Sec-Fetch-Site values, even when both are same-origin', () => {
    const req = repeated('sec-fetch-site', 'same-origin', 'same-origin');
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('cross_site');
  });

  it('refuses two X-CSRF-Token values, even when both are the session token', async () => {
    const token = randomToken();
    const hash = await sha256Hex(token);
    const req = repeated('x-csrf-token', token, token);
    expect(await tokenReasonOf(() => assertCsrfToken(req, hash))).toBe('token_missing');
  });
});

describe('login without a session', () => {
  it('refuses a foreign Origin on POST /_pb/auth/local/login', () => {
    const req = new Request(`${ORIGIN}/_pb/auth/local/login`, {
      method: 'POST',
      headers: { origin: 'https://evil.test' },
    });
    expect(reasonOf(() => assertSameOrigin(req, ORIGIN))).toBe('origin_mismatch');
  });
});

describe('assertCsrfToken', () => {
  async function fixture(): Promise<{ token: string; hash: string }> {
    const token = randomToken();
    return { token, hash: await sha256Hex(token) };
  }

  it('accepts the session token', async () => {
    const { token, hash } = await fixture();
    const req = request('POST', { 'x-csrf-token': token });
    await expect(assertCsrfToken(req, hash)).resolves.toBeUndefined();
  });

  it('refuses a missing header', async () => {
    const { hash } = await fixture();
    expect(await tokenReasonOf(() => assertCsrfToken(request('POST'), hash))).toBe('token_missing');
  });

  it('refuses an empty header', async () => {
    const { hash } = await fixture();
    const req = request('POST', { 'x-csrf-token': '' });
    expect(await tokenReasonOf(() => assertCsrfToken(req, hash))).toBe('token_missing');
  });

  it('refuses 42 and 44 characters', async () => {
    const { token, hash } = await fixture();
    for (const value of [token.slice(0, 42), `${token}A`]) {
      const req = request('POST', { 'x-csrf-token': value });
      expect(await tokenReasonOf(() => assertCsrfToken(req, hash))).toBe('token_missing');
    }
  });

  it('refuses 43 characters outside base64url', async () => {
    const { token, hash } = await fixture();
    for (const value of [
      `${token.slice(0, 42)}+`,
      `${token.slice(0, 42)}.`,
      `${token.slice(0, 42)}=`,
    ]) {
      const req = request('POST', { 'x-csrf-token': value });
      expect(await tokenReasonOf(() => assertCsrfToken(req, hash))).toBe('token_missing');
    }
  });

  it('refuses a valid token of another session', async () => {
    const { hash } = await fixture();
    const req = request('POST', { 'x-csrf-token': randomToken() });
    expect(await tokenReasonOf(() => assertCsrfToken(req, hash))).toBe('token_mismatch');
  });

  it('refuses a token against a malformed stored hash', async () => {
    const { token, hash } = await fixture();
    const req = request('POST', { 'x-csrf-token': token });
    for (const bad of ['', hash.toUpperCase(), hash.slice(1), `${hash}0`, null, undefined]) {
      expect(await tokenReasonOf(() => assertCsrfToken(req, bad as unknown as string))).toBe(
        'token_mismatch',
      );
    }
  });

  it('keeps the token out of the error message', async () => {
    const { hash } = await fixture();
    const token = randomToken();
    const req = request('POST', { 'x-csrf-token': token });
    const error = await assertCsrfToken(req, hash).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CsrfError);
    const csrf = error as CsrfError;
    expect(csrf.reason).toBe('token_mismatch');
    expect(csrf.message).toBe(csrf.reason);
    expect(csrf.message).not.toContain(token);
  });
});
