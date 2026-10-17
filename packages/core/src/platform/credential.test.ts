import { describe, expect, it } from 'vitest';
import { containsCredentialToken, looksLikeCredential } from './credential.js';

const DETECTED: readonly [string, string][] = [
  ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id (whole value)'],
  ['ASIAIOSFODNN7EXAMPLE', 'AWS temporary access key id'],
  ['akiaiosfodnn7example', 'access key id in lower case'],
  ['prefix_AKIAIOSFODNN7EXAMPLE', 'access key id embedded in a value'],
  ['A'.repeat(31) + 'b' + 'c'.repeat(0), 'alphanumeric token run of 32 or more'],
  ['abc-def_ghi-jkl_mno-pqr_stu-vwx_yz01', 'token run with separators, 32 or more'],
  ['MFRGGZDFMZTWQ2LK', 'base32 word'],
  ['mfrggzdfmztwq2lk', 'base32 word in lower case'],
  ['PREFIX_MFRGGZDFMZTWQ2LK', 'base32 word after underscore'],
  ['PREFIX.MFRGGZDFMZTWQ2LK', 'base32 word after dot'],
  ['PREFIX-MFRGGZDFMZTWQ2LK', 'base32 word after dash'],
  ['0123456789ABCDEF', 'hex word'],
  ['0123456789abcdef', 'hex word in lower case'],
  ['x.0123456789abcdef', 'hex word after dot'],
  ['abcdefghijklmnopqrstuvwx', 'word of 24 or more characters'],
  ['my.abcdefghijklmnopqrstuvwx', 'long word after dot'],
  ['abcde.fghij.klmno.pqrst.uvwxy', 'long word spanning a dot when split on underscore only'],
  ['Abcdefghij1klmnopqrs', 'mixed letters and digits word of 20 or more'],
  ['My.Abcdefghij1klmnopqrs', 'mixed long word after dot'],
  ['bcdfghjk', 'consonant-only word of 8 or more'],
  ['ok_bcdfghjk', 'consonant-only word after underscore'],
  ['ok.bcdfghjk', 'consonant-only word after dot'],
  ['Ab12_Cd34', 'two mixed words'],
  ['Ab12.Cd34', 'two mixed words split on dot'],
  ['Ab12-Cd34', 'two mixed words split on dash'],
];

const ALLOWED: readonly [string, string][] = [
  ['R2_BUCKET', 'plain binding name'],
  ['STORAGE_ACCESS_KEY_ID', 'env name'],
  ['package-broker', 'namespace'],
  ['cache.v1', 'dotted namespace'],
  ['Ab12', 'single mixed word'],
  ['', 'empty value'],
];

describe('containsCredentialToken', () => {
  it('flags an embedded access key id or token run but not word-length rules', () => {
    expect(containsCredentialToken('Tool/1 AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(containsCredentialToken(`Tool/1 ${'a'.repeat(32)}`)).toBe(true);
    expect(containsCredentialToken('Composer/2.8.0 (Linux; PackageBroker)')).toBe(false);
  });
});

describe('looksLikeCredential', () => {
  it.each(DETECTED)('detects %s (%s)', (value) => {
    expect(looksLikeCredential(value)).toBe(true);
  });

  it.each(ALLOWED)('allows %s (%s)', (value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});
