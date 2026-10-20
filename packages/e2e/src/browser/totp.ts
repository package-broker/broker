export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

export interface TotpOptions {
  readonly algorithm?: TotpAlgorithm;
  readonly digits?: number;
  readonly period?: number;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Uint8Array {
  if (!/^[A-Z2-7]+$/.test(text)) throw new TypeError('not an unpadded RFC 4648 base32 string');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Uint8Array.from(bytes);
}

export async function hotp(
  secret: Uint8Array,
  counter: number,
  options: Pick<TotpOptions, 'algorithm' | 'digits'> = {},
): Promise<string> {
  const { algorithm = 'SHA-1', digits = 6 } = options;
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter));
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1]! & 15;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function stepAt(timeMs: number, period = 30): number {
  return Math.floor(timeMs / (period * 1000));
}

export function totp(
  secret: Uint8Array,
  timeMs: number,
  options: TotpOptions = {},
): Promise<string> {
  const { period = 30, ...rest } = options;
  return hotp(secret, stepAt(timeMs, period), rest);
}

/** Milliseconds from `nowMs` until the given step begins; zero once it has begun. */
export function msUntilStep(step: number, nowMs: number, period = 30): number {
  return Math.max(0, step * period * 1000 - nowMs);
}

export interface Otpauth {
  readonly type: string;
  readonly label: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export function parseOtpauth(uri: string): Otpauth {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp') {
    throw new TypeError('not an otpauth TOTP URI');
  }
  const parameters: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(parameters, name)) throw new TypeError(`repeated parameter ${name}`);
    parameters[name] = value;
  }
  return {
    type: url.hostname,
    label: decodeURIComponent(url.pathname.slice(1)),
    parameters,
  };
}
