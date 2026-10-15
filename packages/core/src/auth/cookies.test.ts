import { describe, expect, it } from 'vitest';
import {
  clearCookie,
  COOKIE_VALUE_PATTERN,
  CSRF_COOKIE,
  LOGIN_COOKIE,
  readCookie,
  serializeCookie,
  SESSION_COOKIE,
} from './cookies.js';

const TOKEN = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

function requestWith(...cookies: string[]): Request {
  const headers = new Headers();
  for (const value of cookies) {
    headers.append('Cookie', value);
  }
  return new Request('https://broker.example/', { headers });
}

describe('constants', () => {
  it('names the three cookies with the __Host- prefix', () => {
    expect(SESSION_COOKIE).toBe('__Host-pb_session');
    expect(CSRF_COOKIE).toBe('__Host-pb_csrf');
    expect(LOGIN_COOKIE).toBe('__Host-pb_login');
  });

  it('exposes the value pattern', () => {
    expect(COOKIE_VALUE_PATTERN.source).toBe('^[A-Za-z0-9._-]{1,4096}$');
    expect(COOKIE_VALUE_PATTERN.test('a'.repeat(4096))).toBe(true);
    expect(COOKIE_VALUE_PATTERN.test('a'.repeat(4097))).toBe(false);
    expect(COOKIE_VALUE_PATTERN.test('')).toBe(false);
    expect(COOKIE_VALUE_PATTERN.test('v1.1.abc_-')).toBe(true);
  });
});

describe('serializeCookie', () => {
  it('serializes the session cookie exactly', () => {
    expect(
      serializeCookie(SESSION_COOKIE, TOKEN, {
        maxAgeSeconds: 3600,
        httpOnly: true,
        sameSite: 'Lax',
      }),
    ).toBe(`__Host-pb_session=${TOKEN}; Path=/; Secure; SameSite=Lax; Max-Age=3600; HttpOnly`);
  });

  it('omits HttpOnly when not requested and never sets Domain', () => {
    const header = serializeCookie(CSRF_COOKIE, TOKEN, {
      maxAgeSeconds: 0,
      httpOnly: false,
      sameSite: 'Strict',
    });
    expect(header).toBe(`__Host-pb_csrf=${TOKEN}; Path=/; Secure; SameSite=Strict; Max-Age=0`);
    expect(header).not.toMatch(/Domain|HttpOnly/);
  });

  it.each(['session', 'pb_session', '__host-pb_session', '__Secure-pb_session', '', '__Host-'])(
    'throws for the name %j',
    (name) => {
      expect(() =>
        serializeCookie(name, TOKEN, { maxAgeSeconds: 1, httpOnly: true, sameSite: 'Lax' }),
      ).toThrow(TypeError);
    },
  );

  it.each(['__Host-pb session', '__Host-a=b', '__Host-a;b', '__Host-a\r\nSet-Cookie: x=y'])(
    'throws for the name with separators %j',
    (name) => {
      expect(() =>
        serializeCookie(name, TOKEN, { maxAgeSeconds: 1, httpOnly: true, sameSite: 'Lax' }),
      ).toThrow(TypeError);
    },
  );

  it.each(['a;b', 'a b', '', 'a=b', 'a,b', '"a"', 'a\r\nSet-Cookie: x=y', 'é', 'a'.repeat(4097)])(
    'throws for the value %j',
    (value) => {
      expect(() =>
        serializeCookie(SESSION_COOKIE, value, {
          maxAgeSeconds: 1,
          httpOnly: true,
          sameSite: 'Lax',
        }),
      ).toThrow(TypeError);
    },
  );

  it('round-trips a dotted login-state value', () => {
    const value = `v1.1.${TOKEN}`;
    const header = serializeCookie(LOGIN_COOKIE, value, {
      maxAgeSeconds: 600,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(header).toBe(
      `__Host-pb_login=${value}; Path=/; Secure; SameSite=Lax; Max-Age=600; HttpOnly`,
    );
    expect(readCookie(requestWith(`${LOGIN_COOKIE}=${value}`), LOGIN_COOKIE)).toBe(value);
  });

  it('accepts a Max-Age of 400 days and rejects more with a RangeError', () => {
    const base = { httpOnly: true, sameSite: 'Lax' } as const;
    expect(
      serializeCookie(SESSION_COOKIE, TOKEN, { ...base, maxAgeSeconds: 34_560_000 }),
    ).toContain('Max-Age=34560000');
    expect(() =>
      serializeCookie(SESSION_COOKIE, TOKEN, { ...base, maxAgeSeconds: 34_560_001 }),
    ).toThrow(RangeError);
    expect(() =>
      serializeCookie(SESSION_COOKIE, TOKEN, { ...base, maxAgeSeconds: Number.MAX_SAFE_INTEGER }),
    ).toThrow(RangeError);
    expect(() =>
      serializeCookie(SESSION_COOKIE, TOKEN, {
        ...base,
        maxAgeSeconds: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(TypeError);
  });

  it('throws for sameSite and httpOnly values outside the type', () => {
    const bad = (sameSite: unknown, httpOnly: unknown): { sameSite: 'Lax'; httpOnly: boolean } =>
      ({ sameSite, httpOnly }) as { sameSite: 'Lax'; httpOnly: boolean };
    for (const [sameSite, httpOnly] of [
      ['None; Domain=evil.example', true],
      ['None', true],
      ['lax', true],
      [undefined, true],
      ['Lax', 'true'],
      ['Lax', undefined],
    ] as const) {
      expect(() =>
        serializeCookie(SESSION_COOKIE, TOKEN, { ...bad(sameSite, httpOnly), maxAgeSeconds: 1 }),
      ).toThrow(TypeError);
      expect(() => clearCookie(SESSION_COOKIE, bad(sameSite, httpOnly))).toThrow(TypeError);
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws for Max-Age %s',
    (maxAgeSeconds) => {
      expect(() =>
        serializeCookie(SESSION_COOKIE, TOKEN, { maxAgeSeconds, httpOnly: true, sameSite: 'Lax' }),
      ).toThrow(TypeError);
    },
  );
});

describe('clearCookie', () => {
  it('expires the cookie immediately', () => {
    expect(clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax' })).toBe(
      '__Host-pb_session=; Path=/; Secure; SameSite=Lax; Max-Age=0; HttpOnly',
    );
    expect(clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: 'Strict' })).toBe(
      '__Host-pb_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0',
    );
  });

  it('throws for a name without the __Host- prefix', () => {
    expect(() => clearCookie('session', { httpOnly: true, sameSite: 'Lax' })).toThrow(TypeError);
  });
});

describe('readCookie', () => {
  it('returns the value with other cookies around it', () => {
    const request = requestWith(`theme=dark; ${SESSION_COOKIE}=${TOKEN}; __Host-pb_csrf=other_1`);
    expect(readCookie(request, SESSION_COOKIE)).toBe(TOKEN);
    expect(readCookie(request, CSRF_COOKIE)).toBe('other_1');
  });

  it('throws for an invalid cookie name', () => {
    const request = requestWith(`${SESSION_COOKIE}=aaa`);
    expect(() => readCookie(request, '')).toThrow(TypeError);
    expect(() => readCookie(request, 'session')).toThrow(TypeError);
    expect(() => readCookie(request, '__Host-')).toThrow(TypeError);
  });

  it('reads cookies with distinct names from two Cookie headers (undici joins them with "; ")', () => {
    const request = requestWith(`${SESSION_COOKIE}=aaa`, `${CSRF_COOKIE}=bbb`);
    expect(request.headers.get('cookie')).toBe(`${SESSION_COOKIE}=aaa; ${CSRF_COOKIE}=bbb`);
    expect(readCookie(request, SESSION_COOKIE)).toBe('aaa');
    expect(readCookie(request, CSRF_COOKIE)).toBe('bbb');
  });

  it('returns null when the cookie is absent or there is no header', () => {
    expect(readCookie(requestWith('theme=dark'), SESSION_COOKIE)).toBeNull();
    expect(readCookie(requestWith(), SESSION_COOKIE)).toBeNull();
  });

  it('returns null for a duplicated name in one header', () => {
    expect(
      readCookie(requestWith(`${SESSION_COOKIE}=aaa; ${SESSION_COOKIE}=bbb`), SESSION_COOKIE),
    ).toBeNull();
    expect(
      readCookie(requestWith(`${SESSION_COOKIE}=aaa; ${SESSION_COOKIE}=aaa`), SESSION_COOKIE),
    ).toBeNull();
  });

  it('returns null for a name duplicated across Cookie header values', () => {
    const request = requestWith(`${SESSION_COOKIE}=aaa`, `${SESSION_COOKIE}=bbb`);
    expect(readCookie(request, SESSION_COOKIE)).toBeNull();
  });

  it('returns null for a duplicate even when the other value is malformed', () => {
    expect(
      readCookie(requestWith(`${SESSION_COOKIE}=a b; ${SESSION_COOKIE}=bbb`), SESSION_COOKIE),
    ).toBeNull();
  });

  it.each(['a b', '"abc"', 'a,b', 'a%20b', 'é', '', 'a'.repeat(4097)])(
    'returns null for the malformed value %j',
    (value) => {
      expect(readCookie(requestWith(`${SESSION_COOKIE}=${value}`), SESSION_COOKIE)).toBeNull();
    },
  );

  it('accepts a value of 4096 characters', () => {
    const value = 'a'.repeat(4096);
    expect(readCookie(requestWith(`${SESSION_COOKIE}=${value}`), SESSION_COOKIE)).toBe(value);
  });

  it('matches the name exactly', () => {
    const request = requestWith(`x${SESSION_COOKIE}=aaa; ${SESSION_COOKIE}x=bbb`);
    expect(readCookie(request, SESSION_COOKIE)).toBeNull();
  });

  it('strips only ASCII space and tab around a pair', () => {
    expect(readCookie(requestWith(` \t${SESSION_COOKIE}=aaa \t; other=x`), SESSION_COOKIE)).toBe(
      'aaa',
    );
    expect(readCookie(requestWith(`other=x;\t${SESSION_COOKIE}\t=\t aaa\t`), SESSION_COOKIE)).toBe(
      'aaa',
    );
  });

  it.each(['\u00a0', '\u0085', '\v', '\f'])('returns null when %j surrounds the value', (space) => {
    expect(
      readCookie(requestWith(`${SESSION_COOKIE}=abc${space}; other=x`), SESSION_COOKIE),
    ).toBeNull();
    expect(
      readCookie(requestWith(`other=x; ${SESSION_COOKIE}=${space}abc`), SESSION_COOKIE),
    ).toBeNull();
  });

  it('does not match a name padded with Unicode whitespace', () => {
    expect(readCookie(requestWith(`\u00a0${SESSION_COOKIE}=abc`), SESSION_COOKIE)).toBeNull();
  });

  it('ignores a pair without an equals sign', () => {
    expect(readCookie(requestWith(`junk; ${SESSION_COOKIE}=aaa`), SESSION_COOKIE)).toBe('aaa');
  });

  it('keeps a base64 padding character out of a value', () => {
    expect(readCookie(requestWith(`${SESSION_COOKIE}=aaa=`), SESSION_COOKIE)).toBeNull();
  });
});
