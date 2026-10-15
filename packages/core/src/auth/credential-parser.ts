import { parseToken } from '../secrets/token-format.js';
import type { ParsedToken } from '../secrets/token-format.js';

export const MAX_AUTHORIZATION_LENGTH = 4096;

// Refusal reasons are for internal logs only; the 401 body must stay generic.
export type CredentialRefusal =
  'too_long' | 'malformed' | 'unsupported_scheme' | 'invalid_encoding' | 'ambiguous' | 'no_token';

export type ParsedCredential =
  | { readonly outcome: 'none' }
  | {
      readonly outcome: 'token';
      readonly scheme: 'bearer' | 'basic';
      readonly token: Extract<ParsedToken, { ok: true }>;
    }
  | { readonly outcome: 'invalid'; readonly reason: CredentialRefusal };

const NONE: ParsedCredential = Object.freeze({ outcome: 'none' });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const COMPANION_VALUES: ReadonlySet<string> = new Set(['', 'x', 'token']);

function refuse(reason: CredentialRefusal): ParsedCredential {
  return { outcome: 'invalid', reason };
}

function decodeBasic(payload: string): string | undefined {
  if (payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) return undefined;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return undefined;
  }
  if (btoa(binary) !== payload) return undefined;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function redacted(token: Extract<ParsedToken, { ok: true }>): Extract<ParsedToken, { ok: true }> {
  const safe = { ok: true, kind: token.kind, selector: token.selector, reserved: token.reserved };
  return Object.defineProperties(safe, {
    secret: { value: token.secret, enumerable: false },
    canonical: { value: token.canonical, enumerable: false },
  }) as Extract<ParsedToken, { ok: true }>;
}

function fromToken(
  scheme: 'bearer' | 'basic',
  token: ParsedToken,
  reason: CredentialRefusal,
): ParsedCredential {
  return token.ok ? { outcome: 'token', scheme, token: redacted(token) } : refuse(reason);
}

function parseBearer(value: string): ParsedCredential {
  return fromToken('bearer', parseToken(value), 'malformed');
}

function parseBasicCredentials(decoded: string): ParsedCredential {
  if (!PRINTABLE_ASCII.test(decoded)) return refuse('invalid_encoding');
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.indexOf(':', separator + 1) >= 0) return refuse('malformed');
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const user = parseToken(username);
  const pass = parseToken(password);
  if (user.ok && pass.ok) {
    return user.canonical === pass.canonical
      ? fromToken('basic', user, 'malformed')
      : refuse('ambiguous');
  }
  if (user.ok) {
    return COMPANION_VALUES.has(password)
      ? fromToken('basic', user, 'malformed')
      : refuse('malformed');
  }
  if (pass.ok) {
    return COMPANION_VALUES.has(username)
      ? fromToken('basic', pass, 'malformed')
      : refuse('malformed');
  }
  return refuse('no_token');
}

function parseBasic(payload: string): ParsedCredential {
  const decoded = decodeBasic(payload);
  return decoded === undefined ? refuse('invalid_encoding') : parseBasicCredentials(decoded);
}

export function parseAuthorization(header: string | null | undefined): ParsedCredential {
  if (header === null || header === undefined) return NONE;
  if (header.length > MAX_AUTHORIZATION_LENGTH) return refuse('too_long');
  if (!PRINTABLE_ASCII.test(header)) return refuse('invalid_encoding');
  if (header.includes(',')) return refuse('malformed');
  const separator = header.indexOf(' ');
  const scheme = (separator < 0 ? header : header.slice(0, separator)).toLowerCase();
  if (scheme !== 'bearer' && scheme !== 'basic') return refuse('unsupported_scheme');
  const value = separator < 0 ? '' : header.slice(separator + 1);
  if (value.length === 0 || value.includes(' ')) return refuse('malformed');
  return scheme === 'bearer' ? parseBearer(value) : parseBasic(value);
}

export function credentialFromHeaders(headers: Headers): ParsedCredential {
  return parseAuthorization(headers.get('authorization'));
}
