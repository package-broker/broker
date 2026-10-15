export const SESSION_COOKIE = '__Host-pb_session';
export const CSRF_COOKIE = '__Host-pb_csrf';
export const LOGIN_COOKIE = '__Host-pb_login';

export const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,4096}$/;

const HOST_NAME_PATTERN = /^__Host-[A-Za-z0-9_-]+$/;
const OWS_EDGES = /^[ \t]+|[ \t]+$/g;
const MAX_AGE_LIMIT_SECONDS = 34_560_000;

interface CookieFlags {
  readonly httpOnly: boolean;
  readonly sameSite: 'Lax' | 'Strict';
}

function stripOws(text: string): string {
  return text.replace(OWS_EDGES, '');
}

function assertName(name: string): void {
  if (!HOST_NAME_PATTERN.test(name)) {
    throw new TypeError('cookie name must start with __Host- and contain only [A-Za-z0-9_-]');
  }
}

function assertFlags(flags: CookieFlags): void {
  if (flags.sameSite !== 'Lax' && flags.sameSite !== 'Strict') {
    throw new TypeError('sameSite must be Lax or Strict');
  }
  if (typeof flags.httpOnly !== 'boolean') {
    throw new TypeError('httpOnly must be a boolean');
  }
}

function attributes(flags: CookieFlags, maxAgeSeconds: number): string {
  const base = `Path=/; Secure; SameSite=${flags.sameSite}; Max-Age=${String(maxAgeSeconds)}`;
  return flags.httpOnly ? `${base}; HttpOnly` : base;
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieFlags & { readonly maxAgeSeconds: number },
): string {
  assertName(name);
  assertFlags(options);
  if (!COOKIE_VALUE_PATTERN.test(value)) {
    throw new TypeError('cookie value does not match the allowed pattern');
  }
  if (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) {
    throw new TypeError('maxAgeSeconds must be an integer >= 0');
  }
  if (options.maxAgeSeconds > MAX_AGE_LIMIT_SECONDS) {
    throw new RangeError('maxAgeSeconds must not exceed 400 days');
  }
  return `${name}=${value}; ${attributes(options, options.maxAgeSeconds)}`;
}

export function clearCookie(name: string, options: CookieFlags): string {
  assertName(name);
  assertFlags(options);
  return `${name}=; ${attributes(options, 0)}`;
}

export function readCookie(request: Request, name: string): string | null {
  assertName(name);
  const header = request.headers.get('cookie');
  if (header === null) {
    return null;
  }
  let found: string | null = null;
  let count = 0;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || stripOws(pair.slice(0, separator)) !== name) {
      continue;
    }
    count += 1;
    found = stripOws(pair.slice(separator + 1));
  }
  if (count !== 1 || found === null || !COOKIE_VALUE_PATTERN.test(found)) {
    return null;
  }
  return found;
}
