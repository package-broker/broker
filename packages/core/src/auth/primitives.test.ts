import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  randomToken,
  sha256Hex,
} from './primitives.js';

describe('randomToken', () => {
  it('is 43 base64url characters by default', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces 1000 distinct tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(randomToken());
    }
    expect(seen.size).toBe(1000);
  });

  it('honours the byte length', () => {
    expect(base64urlDecode(randomToken(16))).toHaveLength(16);
    expect(randomToken(1)).toHaveLength(2);
  });

  it('accepts 65536 bytes and rejects more', () => {
    expect(base64urlDecode(randomToken(65_536))).toHaveLength(65_536);
    expect(() => randomToken(65_537)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects byte length %s',
    (length) => {
      expect(() => randomToken(length)).toThrow(RangeError);
    },
  );
});

describe('base64url', () => {
  it('round-trips lengths 0..40', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 0xff);
      const text = base64urlEncode(bytes);
      expect(text).not.toMatch(/[+/=]/);
      expect(base64urlDecode(text)).toEqual(bytes);
    }
  });

  it('encodes the url-safe alphabet without padding', () => {
    expect(base64urlEncode(Uint8Array.of(0xfb, 0xff, 0xfe))).toBe('-__-');
    expect(base64urlEncode(Uint8Array.of(0xff))).toBe('_w');
  });

  it.each(['+', '/', '=', 'AA==', 'a+b/', 'AAA=', ' AAAA', 'AAAA\n', 'A', 'AAAAA'])(
    'rejects %j',
    (text) => {
      expect(() => base64urlDecode(text)).toThrow(TypeError);
    },
  );

  it('rejects a non-canonical last character', () => {
    expect(base64urlDecode('_w')).toEqual(Uint8Array.of(0xff));
    expect(() => base64urlDecode('_x')).toThrow(TypeError);
    expect(() => base64urlDecode('AB')).toThrow(TypeError);
    expect(() => base64urlDecode('AAB')).toThrow(TypeError);
  });

  it('rejects non-ASCII input', () => {
    expect(() => base64urlDecode('AAAé')).toThrow(TypeError);
  });
});

describe('sha256Hex', () => {
  it('matches the known vector', async () => {
    await expect(sha256Hex('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc')).resolves.toBe(
      'dc4bf80c77473d130fa0de86ba4018fe98bb214005e6a5891d12ba91446f9e81',
    );
  });

  it('hashes the empty string', async () => {
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('constantTimeEqual', () => {
  it('is true for equal inputs', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('is false when the first or the last byte differs', () => {
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(0, 2, 3))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(constantTimeEqual('abc', 'xbc')).toBe(false);
    expect(constantTimeEqual('abc', 'abx')).toBe(false);
  });

  it('is false for different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1), Uint8Array.of())).toBe(false);
  });

  it('never treats strings with lone surrogates as equal', () => {
    expect(constantTimeEqual('\uD800', '\uDBFF')).toBe(false);
    expect(constantTimeEqual('a\uDC00', 'a\uFFFD')).toBe(false);
    expect(constantTimeEqual('\uD800', '\uD800')).toBe(false);
    expect(constantTimeEqual('\uD800', Uint8Array.of(0xef, 0xbf, 0xbd))).toBe(false);
    expect(constantTimeEqual('\uD83D\uDE00', '\uD83D\uDE00')).toBe(true);
  });

  it('compares a string with bytes by its UTF-8 encoding', () => {
    expect(constantTimeEqual('abc', Uint8Array.of(97, 98, 99))).toBe(true);
    expect(constantTimeEqual('é', Uint8Array.of(0xc3, 0xa9))).toBe(true);
  });
});
