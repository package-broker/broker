export class NotificationConfigError extends Error {
  readonly code = 'invalid_configuration';

  constructor() {
    super('Invalid notification configuration');
    this.name = 'NotificationConfigError';
  }
}

export type NotificationMethod = 'POST' | 'PUT';
export type NotificationHeader = readonly [name: string, value: string];

export interface DestinationOptions {
  readonly selfOrigins: readonly string[];
}

const MAX_URL_LENGTH = 2048;
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE_BYTES = 8192;

const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
  '.corp',
  '.test',
  '.example',
  '.invalid',
  '.onion',
];
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^(?:[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?)?$/;
const RESERVED_X_PREFIXES = ['x-package-broker-', 'x-forwarded-', 'x-b3-'];
const CLIENT_ADDRESS = /^x-(?:real|client|cluster-client)-ip$/;
const RESERVED_X_NAMES = new Set(['x-request-id', 'x-amzn-trace-id', 'x-cloud-trace-context']);
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

function refuse(): never {
  throw new NotificationConfigError();
}

/** A configured origin with a scheme is compared as an origin; a bare host is compared as a host. */
function isSelf(destination: URL, origin: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
    try {
      return new URL(origin).origin === destination.origin;
    } catch {
      return origin.toLowerCase() === destination.hostname;
    }
  }
  return origin.toLowerCase() === destination.hostname;
}

function isControl(char: string): boolean {
  return char < ' ' || char === '\u007f';
}

function isLocalName(host: string): boolean {
  return !host.includes('.') || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * An early refusal of destinations that cannot be public receivers. Names resolve later, so the
 * transport check made before each delivery attempt is the binding control, not this one.
 */
export function validateNotificationDestination(url: string, options: DestinationOptions): string {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) refuse();
  if (/[\s#\\]/.test(url) || Array.from(url).some(isControl)) refuse();
  if (!/^https:\/\//i.test(url)) refuse();
  const authority = url.slice('https://'.length).split(/[/?]/, 1)[0] ?? '';
  if (authority.includes('@')) refuse();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse();
  }
  const host = parsed.hostname;
  if (
    parsed.port !== '' ||
    host.startsWith('[') ||
    IPV4_HOST.test(host) ||
    host.endsWith('.') ||
    isLocalName(host) ||
    options.selfOrigins.some((origin) => isSelf(parsed, origin)) ||
    parsed.href.length > MAX_URL_LENGTH
  ) {
    refuse();
  }
  return parsed.href;
}

export function validateNotificationMethod(value: unknown): NotificationMethod {
  if (value !== 'POST' && value !== 'PUT') refuse();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function headerEntries(value: unknown): readonly (readonly [unknown, unknown])[] {
  if (Array.isArray(value)) {
    return value.map((pair: unknown) => {
      if (!Array.isArray(pair) || pair.length !== 2) refuse();
      return [pair[0], pair[1]] as const;
    });
  }
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) refuse();
  return Object.keys(value).map((name) => {
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(value, name);
    return [name, descriptor?.value] as const;
  });
}

function isPermittedName(lower: string): boolean {
  if (lower === 'authorization') return true;
  if (!lower.startsWith('x-')) return false;
  return (
    !RESERVED_X_NAMES.has(lower) &&
    !CLIENT_ADDRESS.test(lower) &&
    !RESERVED_X_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

const encoder = new TextEncoder();

export function validateNotificationHeaders(value: unknown): readonly NotificationHeader[] {
  const entries = headerEntries(value);
  if (entries.length > MAX_HEADERS) refuse();
  const seen = new Set<string>();
  let valueBytes = 0;
  const headers: NotificationHeader[] = [];
  for (const [name, headerValue] of entries) {
    if (typeof name !== 'string' || typeof headerValue !== 'string') return refuse();
    if (!TOKEN.test(name) || !HEADER_VALUE.test(headerValue)) refuse();
    const lower = name.toLowerCase();
    if (!isPermittedName(lower) || seen.has(lower)) refuse();
    seen.add(lower);
    valueBytes += encoder.encode(headerValue).length;
    if (valueBytes > MAX_HEADER_VALUE_BYTES) refuse();
    headers.push(Object.freeze([name, headerValue] as const));
  }
  return Object.freeze(headers);
}

export function validateSigningKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL_32_BYTES.test(value)) refuse();
  const binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}=`);
  const key = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const canonical = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== value) refuse();
  return key;
}
