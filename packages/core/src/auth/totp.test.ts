import { describe, expect, it, vi } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decodeTotpEnvelope,
  encodeTotpEnvelope,
  generateTotpSecret,
  provisioningUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpCode,
  verifyTotp,
} from './totp.js';

const SECRET = new TextEncoder().encode('12345678901234567890');
const SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const NOW_SECONDS = 1_111_111_111;
const STEP = Math.floor(NOW_SECONDS / TOTP_PERIOD_SECONDS);
const NOW_MS = NOW_SECONDS * 1000;

describe('constants', () => {
  it('uses 30 second steps and 6 digits', () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
  });
});

describe('totpCode', () => {
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ])('matches the RFC 6238 vector at T=%i', async (seconds, expected) => {
    expect(await totpCode(SECRET, Math.floor(seconds / 30))).toBe(expected);
  });
});

describe('totpCode format', () => {
  it('always yields six digits', async () => {
    for (let step = 0; step < 300; step += 1) {
      expect(await totpCode(generateTotpSecret(), step)).toMatch(/^[0-9]{6}$/);
    }
  });

  it.each([[0], [1], [19], [21], [32]])('refuses a %i byte secret', async (length) => {
    await expect(totpCode(new Uint8Array(length), 1)).rejects.toThrow(TypeError);
  });

  it('refuses a negative or fractional step', async () => {
    await expect(totpCode(SECRET, -1)).rejects.toThrow(RangeError);
    await expect(totpCode(SECRET, 1.5)).rejects.toThrow(RangeError);
  });
});

describe('base32', () => {
  it('encodes the RFC secret', () => {
    expect(base32Encode(SECRET)).toBe(SECRET_BASE32);
  });

  it('round trips the RFC secret', () => {
    expect(base32Decode(SECRET_BASE32)).toEqual(SECRET);
  });

  it('round trips random secrets of every length up to 32', () => {
    for (let length = 1; length <= 32; length += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it('matches the RFC 4648 test vectors without padding', () => {
    const encoder = new TextEncoder();
    expect(base32Encode(encoder.encode('f'))).toBe('MY');
    expect(base32Encode(encoder.encode('fo'))).toBe('MZXQ');
    expect(base32Encode(encoder.encode('foo'))).toBe('MZXW6');
    expect(base32Encode(encoder.encode('foob'))).toBe('MZXW6YQ');
    expect(base32Encode(encoder.encode('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(encoder.encode('foobar'))).toBe('MZXW6YTBOI');
  });

  it.each([
    ['empty text', ''],
    ['lowercase', 'gezdgnbvgy3tqojq'],
    ['padding', 'MY======'],
    ['invalid character 1', 'GEZDGNB1'],
    ['whitespace', 'GEZD GNBV'],
    ['non-zero trailing bits', 'MZ'],
    ['impossible length', 'M'],
    ['impossible length 3', 'MZX'],
    ['impossible length 6', 'MZXW6Y'],
  ])('rejects %s', (_name, text) => {
    expect(() => base32Decode(text)).toThrow(TypeError);
  });
});

describe('generateTotpSecret', () => {
  it('returns 20 random bytes', () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.length).toBe(20);
    expect(first).not.toEqual(second);
  });
});

describe('verifyTotp', () => {
  it('accepts the current code and returns its step', async () => {
    const code = await totpCode(SECRET, STEP);
    expect(await verifyTotp(SECRET, code, NOW_MS, null)).toEqual({ ok: true, step: STEP });
  });

  it('accepts the codes of t-1 and t+1', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP - 1), NOW_MS, null)).toEqual({
      ok: true,
      step: STEP - 1,
    });
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP + 1), NOW_MS, null)).toEqual({
      ok: true,
      step: STEP + 1,
    });
  });

  it('refuses the codes of t-2 and t+2', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP - 2), NOW_MS, null)).toEqual({
      ok: false,
    });
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP + 2), NOW_MS, null)).toEqual({
      ok: false,
    });
  });

  it('refuses a replay of the stored step and accepts the next one', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP), NOW_MS, STEP)).toEqual({
      ok: false,
    });
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP + 1), NOW_MS, STEP)).toEqual({
      ok: true,
      step: STEP + 1,
    });
  });

  it('refuses a step older than the stored one', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP - 1), NOW_MS, STEP)).toEqual({
      ok: false,
    });
  });

  it('with a stored step ahead of the clock refuses older codes until time catches up', async () => {
    const lastStep = STEP + 1;
    for (const offset of [-1, 0, 1]) {
      expect(
        await verifyTotp(SECRET, await totpCode(SECRET, STEP + offset), NOW_MS, lastStep),
      ).toEqual({ ok: false });
    }
    const later = (STEP + 1) * TOTP_PERIOD_SECONDS * 1000;
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP + 2), later, lastStep)).toEqual({
      ok: true,
      step: STEP + 2,
    });
  });

  it('accepts step 0 when no step is stored', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, 0), 0, null)).toEqual({
      ok: true,
      step: 0,
    });
  });

  it('refuses step 0 when step 0 is stored', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, 0), 0, 0)).toEqual({ ok: false });
  });

  it('refuses a wrong code', async () => {
    const code = await totpCode(SECRET, STEP);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(await verifyTotp(SECRET, wrong, NOW_MS, null)).toEqual({ ok: false });
  });

  it.each([['28708'], ['2870822'], ['28708a'], [' 287082'], ['287082 '], [''], ['٢٨٧٠٨٢']])(
    'rejects the malformed code %j',
    async (code) => {
      expect(await verifyTotp(SECRET, code, 59_000, null)).toEqual({ ok: false });
    },
  );

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    [-1],
    [-60_000],
    [1e30],
  ])('refuses every code for the clock value %s without throwing', async (nowMs) => {
    for (const step of [0, 1, STEP]) {
      expect(await verifyTotp(SECRET, await totpCode(SECRET, step), nowMs, null)).toEqual({
        ok: false,
      });
    }
  });

  it('treats an undefined stored step like null', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP), NOW_MS, undefined)).toEqual({
      ok: true,
      step: STEP,
    });
  });

  it.each([[0], [19], [21]])(
    'refuses every code for a %i byte secret and still runs three HMACs',
    async (length) => {
      const spy = vi.spyOn(crypto.subtle, 'sign');
      try {
        expect(await verifyTotp(new Uint8Array(length), '287082', 59_000, null)).toEqual({
          ok: false,
        });
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('refuses everything when the stored step is NaN', async () => {
    expect(await verifyTotp(SECRET, await totpCode(SECRET, STEP), NOW_MS, Number.NaN)).toEqual({
      ok: false,
    });
  });

  it('returns the highest matching step when the window steps share a code', async () => {
    const spy = vi
      .spyOn(crypto.subtle, 'sign')
      .mockImplementation(async () => new Uint8Array(20).fill(7).buffer);
    try {
      const code = await totpCode(SECRET, STEP);
      expect(await verifyTotp(SECRET, code, NOW_MS, null)).toEqual({ ok: true, step: STEP + 1 });
      expect(await verifyTotp(SECRET, code, NOW_MS, STEP)).toEqual({ ok: true, step: STEP + 1 });
      expect(await verifyTotp(SECRET, code, NOW_MS, STEP + 1)).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts the vector code presented at the vector time', async () => {
    expect(await verifyTotp(SECRET, '287082', 59_000, null)).toEqual({ ok: true, step: 1 });
  });
});

describe('provisioningUri', () => {
  it('builds the exact URI', () => {
    expect(provisioningUri(SECRET, 'admin@example.com')).toBe(
      `otpauth://totp/Package%20Broker:admin%40example.com?secret=${SECRET_BASE32}&issuer=Package%20Broker&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it('refuses an empty e-mail', () => {
    expect(() => provisioningUri(SECRET, '')).toThrow(TypeError);
  });

  it.each([[0], [19], [21]])('refuses a %i byte secret', (length) => {
    expect(() => provisioningUri(new Uint8Array(length), 'a@example.com')).toThrow(TypeError);
  });

  it('refuses an e-mail containing a colon', () => {
    expect(() => provisioningUri(SECRET, 'a:b@example.com')).toThrow(TypeError);
  });

  it('percent-encodes characters that would break the label', () => {
    const uri = provisioningUri(SECRET, 'a b+c&d@example.com');
    expect(uri).toContain('otpauth://totp/Package%20Broker:a%20b%2Bc%26d%40example.com?');
  });
});

describe('TOTP envelope', () => {
  const userId = '01J0000000000000000000000A';

  it('encodes UTF-8 JSON with u and s', () => {
    const text = new TextDecoder().decode(encodeTotpEnvelope(userId, SECRET));
    expect(text).toBe(`{"u":"${userId}","s":"${SECRET_BASE32}"}`);
  });

  it.each([[0], [19], [21]])('refuses to encode a %i byte secret', (length) => {
    expect(() => encodeTotpEnvelope(userId, new Uint8Array(length))).toThrow(TypeError);
  });

  it('round trips', () => {
    expect(decodeTotpEnvelope(encodeTotpEnvelope(userId, SECRET), userId)).toEqual(SECRET);
  });

  it('refuses another user id', () => {
    expect(() =>
      decodeTotpEnvelope(encodeTotpEnvelope(userId, SECRET), '01J0000000000000000000000B'),
    ).toThrow(TypeError);
  });

  it.each([
    ['non-JSON', 'not json'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['missing s', '{"u":"01J0000000000000000000000A"}'],
    ['missing u', `{"s":"${SECRET_BASE32}"}`],
    ['non-string s', '{"u":"01J0000000000000000000000A","s":1}'],
    ['invalid base32', '{"u":"01J0000000000000000000000A","s":"abc"}'],
    ['empty secret', '{"u":"01J0000000000000000000000A","s":""}'],
    ['an extra key', `{"u":"01J0000000000000000000000A","s":"${SECRET_BASE32}","x":1}`],
    ['a secret shorter than 20 bytes', '{"u":"01J0000000000000000000000A","s":"MZXW6YTB"}'],
    [
      'a secret longer than 20 bytes',
      `{"u":"01J0000000000000000000000A","s":"${SECRET_BASE32}AA"}`,
    ],
  ])('refuses %s', (_name, text) => {
    expect(() => decodeTotpEnvelope(new TextEncoder().encode(text), userId)).toThrow(TypeError);
  });

  it('refuses invalid UTF-8', () => {
    expect(() => decodeTotpEnvelope(new Uint8Array([0xff, 0xfe]), userId)).toThrow(TypeError);
  });
});
