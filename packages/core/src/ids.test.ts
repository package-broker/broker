import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ids from './ids.js';

let api: typeof ids;

beforeEach(async () => {
  vi.resetModules();
  api = await import('./ids.js');
});

describe('ulid', () => {
  it('formats as Crockford base32 with a 0-7 first character', () => {
    expect(api.ulid(0)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('round-trips the timestamp', () => {
    expect(api.ulidTime(api.ulid(1_700_000_000_123))).toBe(1_700_000_000_123);
  });

  it('is strictly increasing for the same millisecond', () => {
    let previous = api.ulid(1_700_000_000_000);
    for (let i = 0; i < 999; i++) {
      const next = api.ulid(1_700_000_000_000);
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  it('keeps monotonicity and the last time when the clock moves backwards', () => {
    const t1 = 1_700_000_000_500;
    const first = api.ulid(t1);
    const second = api.ulid(t1 - 1000);
    expect(second > first).toBe(true);
    expect(api.ulidTime(second)).toBe(t1);
  });

  it('rejects an out-of-range time', () => {
    expect(() => api.ulid(-1)).toThrow(RangeError);
    expect(() => api.ulid(1.5)).toThrow(RangeError);
    expect(() => api.ulid(2 ** 48)).toThrow(RangeError);
  });

  it('throws when the random part overflows', () => {
    const filled = new Uint8Array(10).fill(0xff);
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).set(filled.subarray(0, array.length));
      return array;
    });
    api.ulid(5);
    expect(() => api.ulid(5)).toThrow('ulid overflow');
    vi.restoreAllMocks();
  });
});

describe('isUlid', () => {
  it('accepts a generated id', () => {
    expect(api.isUlid(api.ulid(0))).toBe(true);
  });

  it('rejects empty, short, excluded letters and a too-large first character', () => {
    expect(api.isUlid('')).toBe(false);
    expect(api.isUlid('0'.repeat(25))).toBe(false);
    for (const letter of ['I', 'L', 'O', 'U']) {
      expect(api.isUlid(`0${letter}${'0'.repeat(24)}`)).toBe(false);
    }
    expect(api.isUlid(`8${'0'.repeat(25)}`)).toBe(false);
  });
});

describe('ulidTime', () => {
  it('throws a TypeError for a value that is not a ULID', () => {
    expect(() => api.ulidTime('not-a-ulid')).toThrow(TypeError);
  });
});

describe('clock', () => {
  it('formats an ISO-8601 UTC timestamp with milliseconds', () => {
    expect(api.isoTimestamp(new Date(Date.UTC(2026, 9, 15, 8, 0, 0, 5)))).toBe(
      '2026-10-15T08:00:00.005Z',
    );
  });

  it('returns the fixed instant', () => {
    const iso = '2026-10-15T08:00:00.000Z';
    expect(api.fixedClock(iso).now().toISOString()).toBe(iso);
  });

  it('exposes a system clock', () => {
    expect(api.systemClock.now()).toBeInstanceOf(Date);
  });
});

describe('idBefore', () => {
  it('returns the greatest same-length id below the given one', () => {
    expect(api.idBefore('0001')).toBe('0000');
    expect(api.idBefore('0010')).toBe('000Z');
    expect(api.idBefore('1000')).toBe('0ZZZ');
  });

  it('returns null at the floor and for characters outside the alphabet', () => {
    expect(api.idBefore('0000')).toBeNull();
    expect(api.idBefore('')).toBeNull();
    expect(api.idBefore('00U0')).toBeNull();
  });
});
