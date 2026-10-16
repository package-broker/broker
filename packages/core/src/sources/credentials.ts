import type { UpstreamCredential } from './policy-fetch.js';

export type CredentialKind =
  'http_basic' | 'bearer' | 'header' | 'query' | 'github_app' | 'npm_token' | 'ssh_key';

export type CredentialErrorCode = 'invalid' | 'unbindable';

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode, reason: string) {
    super(`credential ${code}: ${reason}`);
    this.name = 'CredentialError';
    this.code = code;
  }
}

interface Redacted {
  toJSON(): string;
  toString(): string;
}

export interface HttpBasicMaterial extends Redacted {
  readonly kind: 'http_basic';
  readonly username: string;
  readonly password: string;
}
export interface BearerMaterial extends Redacted {
  readonly kind: 'bearer';
  readonly token: string;
}
export interface HeaderMaterial extends Redacted {
  readonly kind: 'header';
  readonly name: string;
  readonly value: string;
}
export interface QueryMaterial extends Redacted {
  readonly kind: 'query';
  readonly param: string;
  readonly value: string;
}
export interface GithubAppMaterial extends Redacted {
  readonly kind: 'github_app';
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly webhookSecret: string;
}
export interface NpmTokenMaterial extends Redacted {
  readonly kind: 'npm_token';
  readonly token: string;
}
export interface SshKeyMaterial extends Redacted {
  readonly kind: 'ssh_key';
  readonly privateKeyPem: string;
  readonly knownHosts: string;
}

export type CredentialMaterial =
  | HttpBasicMaterial
  | BearerMaterial
  | HeaderMaterial
  | QueryMaterial
  | GithubAppMaterial
  | NpmTokenMaterial
  | SshKeyMaterial;

export interface CredentialEchoProbe {
  readonly secrets: readonly string[];
  readonly queryParams: readonly string[];
}

const MAX_PLAINTEXT_BYTES = 16 * 1024;
const MIN_SECRET_LENGTH = 8;
const REDACTED = '[redacted]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set(['x-api-key', 'private-token']);
const TOKEN = /^[\x21-\x7e]+$/;
const HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const PRIVATE_KEY =
  /^-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[A-Za-z0-9+/= \t\r\n]+-----END \1PRIVATE KEY-----[ \t\r\n]*$/;
const KNOWN_HOSTS_LINE =
  /^(@(cert-authority|revoked) )?\S+ (ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+( .*)?$/;
const BARE_HTTPS_ORIGIN = /^https:\/\/[^/?#@\\\s]+$/i;
const DNS_HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Check = (value: string) => boolean;

const secret: Check = (v) => v.length >= MIN_SECRET_LENGTH && !/[\r\n]/.test(v);
const token: Check = (v) => v.length >= MIN_SECRET_LENGTH && TOKEN.test(v);
const privateKey: Check = (v) => PRIVATE_KEY.test(v);
const knownHosts: Check = (v) => {
  const lines = v.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'));
  return lines.length > 0 && lines.every((line) => KNOWN_HOSTS_LINE.test(line));
};

const NORMALISE: Readonly<Record<string, (value: string) => string>> = {
  privateKeyPem: (v) => `${v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')}\n`,
  knownHosts: (v) =>
    v
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''))
      .join('\n'),
};

const SHAPES: Readonly<Record<CredentialKind, Readonly<Record<string, Check>>>> = {
  http_basic: {
    username: (v) => v.length > 0 && !v.includes(':') && !/[\r\n]/.test(v),
    password: secret,
  },
  bearer: { token },
  header: {
    name: (v) => HEADER_ALLOWLIST.has(v.trim().toLowerCase()),
    value: (v) => v.length >= MIN_SECRET_LENGTH && HEADER_VALUE.test(v),
  },
  query: { param: (v) => PARAM_NAME.test(v), value: secret },
  github_app: { appId: (v) => APP_ID.test(v), privateKeyPem: privateKey, webhookSecret: secret },
  npm_token: { token },
  ssh_key: { privateKeyPem: privateKey, knownHosts },
};

const genuine = new WeakSet<object>();

const invalid = (reason: string): CredentialError => new CredentialError('invalid', reason);

export function parseCredentialMaterial(
  kind: CredentialKind,
  plaintext: string | Uint8Array,
): CredentialMaterial {
  const shape = Object.hasOwn(SHAPES, kind) ? SHAPES[kind] : undefined;
  if (shape === undefined) throw invalid('kind');
  if (typeof plaintext === 'string' && plaintext.length > MAX_PLAINTEXT_BYTES)
    throw invalid('size');
  const bytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw invalid('size');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid('format');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw invalid('format');
  const record = parsed as Record<string, unknown>;
  const expected = Object.keys(shape);
  if (
    Object.keys(record).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(record, key))
  ) {
    throw invalid('fields');
  }
  const fields: Record<string, string> = {};
  for (const [key, check] of Object.entries(shape)) {
    const raw = record[key];
    if (typeof raw !== 'string' || LONE_SURROGATE.test(raw)) throw invalid('fields');
    const normalise = Object.hasOwn(NORMALISE, key) ? NORMALISE[key] : undefined;
    const value = kind === 'header' ? raw.trim() : normalise ? normalise(raw) : raw;
    if (!check(value)) throw invalid('fields');
    fields[key] = kind === 'header' && key === 'name' ? value.toLowerCase() : value;
  }
  Object.freeze(fields);

  const material: Record<PropertyKey, unknown> = { kind };
  for (const key of expected) {
    Object.defineProperty(material, key, { enumerable: false, get: () => fields[key] });
  }
  const redact = (): string => REDACTED;
  Object.defineProperty(material, 'toJSON', { enumerable: false, value: redact });
  Object.defineProperty(material, 'toString', { enumerable: false, value: redact });
  Object.defineProperty(material, INSPECT, { enumerable: false, value: redact });
  Object.freeze(material);
  genuine.add(material);
  return material as unknown as CredentialMaterial;
}

function assertGenuine(material: CredentialMaterial): void {
  if (typeof material !== 'object' || material === null || !genuine.has(material)) {
    throw invalid('material');
  }
}

function canonicalHttpsOrigin(text: unknown): string {
  if (typeof text !== 'string' || !BARE_HTTPS_ORIGIN.test(text.trim())) throw invalid('origin');
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw invalid('origin');
  }
  if (!DNS_HOST.test(url.hostname) && !IPV6_HOST.test(url.hostname)) throw invalid('origin');
  return url.origin;
}

function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function basicToken(username: string, password: string): string {
  return base64(`${username}:${password}`);
}

function encodedForms(text: string): string[] {
  const padded = base64(text);
  const unpadded = padded.replace(/=+$/, '');
  return [
    text,
    encodeURIComponent(text),
    new URLSearchParams({ v: text }).toString().slice(2),
    padded,
    unpadded,
    unpadded.replaceAll('+', '-').replaceAll('/', '_'),
  ];
}

export function bindCredential(
  material: CredentialMaterial,
  origins: readonly string[],
): UpstreamCredential {
  assertGenuine(material);
  if (material.kind === 'github_app' || material.kind === 'ssh_key') {
    throw new CredentialError('unbindable', material.kind);
  }
  if (!Array.isArray(origins) || origins.length === 0) throw invalid('origin');
  const boundSet: ReadonlySet<string> = new Set(origins.map(canonicalHttpsOrigin));

  let headerName: string | undefined;
  let headerValue: string | undefined;
  let param: { readonly name: string; readonly value: string } | undefined;
  switch (material.kind) {
    case 'http_basic':
      headerName = 'authorization';
      headerValue = `Basic ${basicToken(material.username, material.password)}`;
      break;
    case 'bearer':
    case 'npm_token':
      headerName = 'authorization';
      headerValue = `Bearer ${material.token}`;
      break;
    case 'header':
      headerName = material.name;
      headerValue = material.value;
      break;
    case 'query':
      param = { name: material.param, value: material.value };
      break;
  }

  return Object.freeze({
    origins: Object.freeze([...boundSet]),
    queryParams: Object.freeze(param === undefined ? [] : [param.name]),
    apply(headers: Headers, url: URL) {
      if (!boundSet.has(url.origin)) return { headers, url };
      if (headerName !== undefined && headerValue !== undefined)
        headers.set(headerName, headerValue);
      if (param !== undefined) url.searchParams.set(param.name, param.value);
      return { headers, url };
    },
  });
}

function pemForms(pem: string): string[] {
  return [...encodedForms(pem), ...encodedForms(pem.replace(/\n$/, ''))];
}

export function credentialEchoProbe(material: CredentialMaterial): CredentialEchoProbe {
  assertGenuine(material);
  const candidates: string[] = [];
  const queryParams: string[] = [];
  switch (material.kind) {
    case 'http_basic':
      candidates.push(
        ...encodedForms(material.password),
        ...encodedForms(`${material.username}:${material.password}`),
      );
      if (material.username.length >= MIN_SECRET_LENGTH) {
        candidates.push(...encodedForms(material.username));
      }
      break;
    case 'bearer':
    case 'npm_token':
      candidates.push(...encodedForms(material.token));
      break;
    case 'header':
      candidates.push(...encodedForms(material.value));
      break;
    case 'query':
      candidates.push(...encodedForms(material.value));
      queryParams.push(material.param);
      break;
    case 'github_app':
      candidates.push(...pemForms(material.privateKeyPem), ...encodedForms(material.webhookSecret));
      break;
    case 'ssh_key':
      candidates.push(...pemForms(material.privateKeyPem));
      break;
  }
  const secrets = [...new Set(candidates)].filter((value) => value.length >= MIN_SECRET_LENGTH);
  return Object.freeze({
    secrets: Object.freeze(secrets),
    queryParams: Object.freeze(queryParams),
  });
}
