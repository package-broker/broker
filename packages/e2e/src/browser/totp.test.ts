import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  hotp,
  msUntilStep,
  parseOtpauth,
  stepAt,
  totp,
  type TotpAlgorithm,
} from './totp.js';

const encoder = new TextEncoder();
const SECRETS: Record<TotpAlgorithm, Uint8Array> = {
  'SHA-1': encoder.encode('12345678901234567890'),
  'SHA-256': encoder.encode('12345678901234567890123456789012'),
  'SHA-512': encoder.encode('1234567890123456789012345678901234567890123456789012345678901234'),
};

describe('RFC 4226 appendix D', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('HOTP counter %i is %s', async (counter, expected) => {
    expect(await hotp(SECRETS['SHA-1'], counter)).toBe(expected);
  });
});

describe('RFC 6238 appendix B', () => {
  const vectors: readonly (readonly [number, string, string, string])[] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  const algorithms: readonly TotpAlgorithm[] = ['SHA-1', 'SHA-256', 'SHA-512'];

  for (const [seconds, ...expected] of vectors) {
    it.each(algorithms.map((algorithm, index) => [algorithm, expected[index]!] as const))(
      `T=${seconds} with %s is %s`,
      async (algorithm, code) => {
        expect(
          await totp(SECRETS[algorithm], seconds * 1000, { algorithm, digits: 8, period: 30 }),
        ).toBe(code);
      },
    );
  }

  it('uses a 30 second period and six digits by default', async () => {
    expect(await totp(SECRETS['SHA-1'], 59_000)).toBe('287082');
    expect(await totp(SECRETS['SHA-1'], 59_000, { period: 60 })).not.toBe('287082');
  });
});

describe('time helpers', () => {
  it('maps a time to a 30 second step and the wait for the next one', () => {
    expect(stepAt(0)).toBe(0);
    expect(stepAt(29_999)).toBe(0);
    expect(stepAt(30_000)).toBe(1);
    expect(msUntilStep(5, 5 * 30_000 - 1_250)).toBe(1_250);
    expect(msUntilStep(5, 5 * 30_000)).toBe(0);
    expect(msUntilStep(5, 6 * 30_000)).toBe(0);
  });
});

describe('base32Decode', () => {
  it('decodes RFC 4648 vectors without padding', () => {
    const text = (value: string) => new TextDecoder().decode(base32Decode(value));
    expect(text('MZXW6YTBOI')).toBe('foobar');
    expect(text('MZXW6YQ')).toBe('foob');
    expect(text('MY')).toBe('f');
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YT1')).toThrow();
    expect(() => base32Decode('mzxw6ytb')).toThrow();
    expect(() => base32Decode('')).toThrow();
  });
});

describe('parseOtpauth', () => {
  const uri =
    'otpauth://totp/Package%20Broker:admin%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Package%20Broker&algorithm=SHA1&digits=6&period=30';

  it('splits a provisioning URI into its parts', () => {
    expect(parseOtpauth(uri)).toEqual({
      type: 'totp',
      label: 'Package Broker:admin@example.test',
      parameters: {
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        issuer: 'Package Broker',
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      },
    });
  });

  it('rejects other schemes, hosts and repeated parameters', () => {
    expect(() => parseOtpauth(uri.replace('otpauth:', 'https:'))).toThrow();
    expect(() => parseOtpauth(uri.replace('//totp/', '//hotp/'))).toThrow();
    expect(() => parseOtpauth(`${uri}&secret=AAAA`)).toThrow();
  });
});
