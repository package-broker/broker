import { describe, expect, it } from 'vitest';
import { base64url, decodeJson, parseJson } from './input.js';
describe('bounded OIDC input grammar', () => {
  it('accepts JSON scalars, bounded arrays, escaped keys and prototype-free objects', () => {
    const value = parseJson(
      '{"__proto__":1,"escaped\\u006bey":[true,false,null,-1.2e2]}',
    ) as object;
    expect(Object.getPrototypeOf(value)).toBe(null);
    expect(value).toEqual({ ['__proto__']: 1, escapedkey: [true, false, null, -120] });
  });
  it.each([
    '{"a":1,"\\u0061":2}',
    '{"x":1,}',
    '[1,]',
    '{"x":NaN}',
    '1 true',
    '1e999',
    '"\\ud800"',
    '"\\udfff"',
    '"unterminated',
    '{"x":"\n"}',
  ])('refuses malformed JSON %j', (text) => {
    expect(() => parseJson(text)).toThrow('invalid_oidc_token');
  });
  it('caps input text before scanning whitespace', () => {
    expect(() => parseJson(' '.repeat(65536) + '0')).toThrow('invalid_oidc_token');
    expect(parseJson(' '.repeat(65535) + '0')).toBe(0);
  });
  it('caps depth at four', () => {
    expect(parseJson('[[[[0]]]]')).toEqual([[[[0]]]]);
    expect(() => parseJson('[[[[[0]]]]]')).toThrow('invalid_oidc_token');
  });
  it('caps each container at 128 entries', () => {
    expect(parseJson(JSON.stringify(Array(128).fill(0)))).toHaveLength(128);
    expect(() => parseJson(JSON.stringify(Array(129).fill(0)))).toThrow('invalid_oidc_token');
    expect(() =>
      parseJson(
        JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i]))),
      ),
    ).toThrow('invalid_oidc_token');
  });
  it('caps total parsed values at 512', () => {
    expect(() => parseJson(JSON.stringify(Array.from({ length: 128 }, () => [0, 1, 2])))).toThrow(
      'invalid_oidc_token',
    );
  });
  it('caps decoded strings at 8192 and wire strings at 16384 characters', () => {
    expect(parseJson(JSON.stringify('a'.repeat(8192)))).toHaveLength(8192);
    expect(() => parseJson(JSON.stringify('a'.repeat(8193)))).toThrow('invalid_oidc_token');
    expect(() => parseJson('"' + '\\u0061'.repeat(3000) + '"')).toThrow('invalid_oidc_token');
  });
  it('refuses invalid UTF-8 and byte-order marks', () => {
    expect(() => decodeJson(new Uint8Array([0xff]))).toThrow('invalid_oidc_token');
    expect(() => decodeJson(new Uint8Array([34, 0xff, 34]))).toThrow('invalid_oidc_token');
    expect(() => decodeJson(new TextEncoder().encode('\ufeff{}'))).toThrow('invalid_oidc_token');
  });
  it('accepts only canonical base64url within the decoded byte cap', () => {
    expect(base64url('YQ', 1)).toEqual(new Uint8Array([97]));
    for (const text of ['YR', 'YQ=', 'Y Q', 'A', 'YQ+', ''])
      expect(() => base64url(text, 2)).toThrow('invalid_oidc_token');
    expect(() => base64url('YWI', 1)).toThrow('invalid_oidc_token');
  });
});
