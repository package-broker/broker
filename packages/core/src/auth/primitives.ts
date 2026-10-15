const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const MAX_TOKEN_BYTES = 65_536;
const LONE_SURROGATE = /\p{Surrogate}/u;
const encoder = new TextEncoder();

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64urlDecode(text: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
    throw new TypeError('invalid base64url');
  }
  const padded =
    text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (base64urlEncode(bytes) !== text) {
    throw new TypeError('non-canonical base64url');
  }
  return bytes;
}

export function randomToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_TOKEN_BYTES) {
    throw new RangeError('byteLength must be an integer from 1 to 65536');
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  let hex = '';
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  if (
    (typeof a === 'string' && LONE_SURROGATE.test(a)) ||
    (typeof b === 'string' && LONE_SURROGATE.test(b))
  ) {
    return false;
  }
  const left = typeof a === 'string' ? encoder.encode(a) : a;
  const right = typeof b === 'string' ? encoder.encode(b) : b;
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
