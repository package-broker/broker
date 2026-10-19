import { describe, expect, it } from 'vitest';
import { parsePendingValidators, UPSTREAM_FORMS } from './validators.js';

describe('parsePendingValidators', () => {
  it('normalises all forms and omitted fields without mutating the input', () => {
    const value = Object.fromEntries(UPSTREAM_FORMS.map((form) => [form, {}]));
    const result = parsePendingValidators(value);
    for (const form of UPSTREAM_FORMS) {
      expect(result[form]).toEqual({ etag: null, lastModified: null, contentSha256: null });
      expect(value[form]).toEqual({});
    }
    expect(parsePendingValidators({})).toEqual({});
  });

  it('accepts boundary header lengths and lowercase SHA-256', () => {
    const value = {
      'npm-packument': {
        etag: 'é'.repeat(1024),
        lastModified: '',
        contentSha256: 'a1'.repeat(32),
      },
    };
    expect(parsePendingValidators(value)).toEqual(value);
  });

  it.each([null, undefined, [], 1, 'value'])('rejects invalid root %j', (value) => {
    expect(() => parsePendingValidators(value)).toThrow(RangeError);
  });

  it('rejects unknown forms without echoing request data', () => {
    expect(() => parsePendingValidators({ 'private-form': {} })).toThrow(
      new RangeError('unknown upstream form'),
    );
  });

  it.each([null, [], 'value', 1])('rejects invalid entry %j', (entry) => {
    expect(() => parsePendingValidators({ 'composer-p2': entry })).toThrow(TypeError);
  });

  it.each(['etag', 'lastModified', 'contentSha256'])('rejects non-string %s', (field) => {
    expect(() => parsePendingValidators({ 'composer-p2': { [field]: 1 } })).toThrow(TypeError);
  });

  it.each(['etag', 'lastModified'])('rejects control characters and oversized %s', (field) => {
    for (const value of [
      'x'.repeat(1025),
      ...Array.from({ length: 32 }, (_, i) => `x${String.fromCharCode(i)}`),
      'x\x7f',
    ]) {
      expect(() => parsePendingValidators({ 'composer-p2': { [field]: value } })).toThrow(
        TypeError,
      );
    }
  });

  it.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n'])(
    'rejects invalid hash %j',
    (contentSha256) => {
      expect(() => parsePendingValidators({ 'composer-p2': { contentSha256 } })).toThrow(TypeError);
    },
  );
});
