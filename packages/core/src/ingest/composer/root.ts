import type { Codecs } from '../../platform/codec.js';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
} from '../../sources/policy-fetch.js';
import { classifyUrl, type OutboundPolicy } from '../../sources/url-policy.js';
import { JsonExtractError, extractMembers, type MemberSelector } from '../json-stream.js';
import { JsonStreamError } from '../json-tokenizer.js';

export type ComposerMode = 'v2' | 'v1-providers' | 'v1-lazy' | 'v1-includes';
export type ComposerRootErrorCode =
  | 'refused'
  | 'origin'
  | 'http_status'
  | 'invalid'
  | 'unsupported'
  | 'too_large'
  | 'timeout'
  | 'network';

export class ComposerRootError extends Error {
  override readonly name = 'ComposerRootError';
  constructor(
    readonly code: ComposerRootErrorCode,
    readonly field?: string,
    readonly status?: number,
  ) {
    super(
      `composer root ${code}${field === undefined ? '' : `: ${field}`}${status === undefined ? '' : ` (${status})`}`,
    );
  }
}

export interface ComposerRootSource {
  /** Repository base URL, or the packages.json URL itself. */
  readonly url: string;
  readonly policy: OutboundPolicy;
  /** Origins besides the packages.json origin that resolved URLs may use. */
  readonly allowedOrigins: readonly string[];
  readonly credential?: UpstreamCredential;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface ComposerRootMessage {
  readonly type: 'warning' | 'info';
  readonly message: string;
  readonly versions?: string;
}

export interface ComposerRootInclude {
  readonly url: string;
  readonly sha1?: string;
  readonly sha256?: string;
}

export interface ComposerRoot {
  readonly mode: ComposerMode;
  readonly packagesJsonUrl: string;
  readonly metadataUrl?: string;
  readonly metadataChangesUrl?: string;
  readonly providersUrl?: string;
  readonly providersLazyUrl?: string;
  readonly providerIncludes?: readonly (ComposerRootInclude & { readonly sha256: string })[];
  readonly includes?: readonly ComposerRootInclude[];
  readonly inlineProviders: boolean;
  readonly partialPackages: boolean;
  readonly inlinePackages: boolean;
  readonly availablePackages?: readonly string[];
  readonly availablePatterns?: readonly string[];
  readonly validator: {
    readonly etag?: string;
    readonly lastModified?: string;
    readonly sha256: string;
  };
  readonly messages: readonly ComposerRootMessage[];
  /** Upstream download mirrors; never exposed to clients. */
  readonly mirrors: readonly { readonly distUrl: string; readonly preferred: boolean }[];
}

export interface ComposerRootStreaming {
  readonly codecs: Pick<Codecs, 'digestTap'>;
  /** Largest streamed body; inline members are buffered individually, then dropped. */
  readonly maxDocumentBytes: number;
  /** Largest inline package or provider member. Default 1 MiB. */
  readonly maxMemberBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_INCLUDES = 1000;
const MAX_MIRRORS = 16;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 1000;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

function nonEmptyObject(value: unknown): value is Json {
  return isObject(value) && Object.keys(value).length > 0;
}

const PLACEHOLDERS = ['package', 'hash', 'version', 'reference', 'type'] as const;
const ABSOLUTE = /^https?:\/\//i;

const TOKEN_MARK = 'pbph0';

function tokenOf(name: string): string {
  return `${TOKEN_MARK}${name}0hpbp`;
}

function protect(template: string): string {
  return PLACEHOLDERS.reduce((text, name) => text.replaceAll(`%${name}%`, tokenOf(name)), template);
}

function restore(url: string): string {
  return PLACEHOLDERS.reduce((text, name) => text.replaceAll(tokenOf(name), `%${name}%`), url);
}

function probeOf(url: string): string {
  return PLACEHOLDERS.reduce(
    (text, name) => text.replaceAll(`%${name}%`, name === 'package' ? 'vendor/package' : '0'),
    url,
  );
}

function resolveTemplate(template: string, base: string): string | null {
  try {
    if (template.includes(TOKEN_MARK)) return null;
    const url = new URL(protect(template), base);
    if (`${url.username}${url.password}${url.hostname}`.includes(TOKEN_MARK)) return null;
    return restore(url.href);
  } catch {
    return null;
  }
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function packagesJsonUrlOf(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  if (!parsed.pathname.endsWith('.json')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/packages.json`;
  }
  return parsed.href;
}

export function baseOf(packagesJsonUrl: string): string {
  const parsed = new URL(packagesJsonUrl);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, '');
  return parsed.href.replace(/\/+$/, '');
}

function messagesOf(root: Json): ComposerRootMessage[] {
  const out: ComposerRootMessage[] = [];
  const add = (type: 'warning' | 'info', message: unknown, versions: unknown): void => {
    if (out.length >= MAX_MESSAGES || typeof message !== 'string' || message === '') return;
    out.push({
      type,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      ...(nonEmptyString(versions) ? { versions: versions.slice(0, MAX_MESSAGE_LENGTH) } : {}),
    });
  };
  for (const type of ['warning', 'info'] as const) {
    add(type, root[type], root[`${type}-versions`]);
  }
  for (const [key, type] of [
    ['warnings', 'warning'],
    ['infos', 'info'],
  ] as const) {
    const list = root[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (isObject(entry)) add(type, entry.message, entry.versions);
    }
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(nonEmptyString);
}

function mirrorsOf(
  value: unknown,
  prefixed: (value: string) => string,
  resolved: (template: string, base: string, field: string) => string,
  base: string,
): { mirrors: { distUrl: string; preferred: boolean }[]; refused: number } {
  const out: { distUrl: string; preferred: boolean }[] = [];
  let refused = 0;
  if (!Array.isArray(value)) return { mirrors: out, refused };
  for (const entry of value) {
    if (out.length >= MAX_MIRRORS) break;
    if (!isObject(entry)) continue;
    const raw = entry['dist-url'] ?? entry.distUrl;
    if (!nonEmptyString(raw)) continue;
    const text = prefixed(raw);
    if (!ABSOLUTE.test(text)) continue;
    try {
      out.push({ distUrl: resolved(text, base, 'mirrors'), preferred: entry.preferred === true });
    } catch (error) {
      if (!(error instanceof ComposerRootError)) throw error;
      refused++;
    }
  }
  return { mirrors: out, refused };
}

const RETAINED_FIELDS = [
  'metadata-url',
  'metadata-changes-url',
  'available-packages',
  'available-package-patterns',
  'providers-url',
  'providers-lazy-url',
  'provider-includes',
  'includes',
  'mirrors',
  'warning',
  'warning-versions',
  'info',
  'info-versions',
  'warnings',
  'infos',
] as const;

const STREAM_SELECTORS: readonly MemberSelector[] = [
  ...RETAINED_FIELDS.map((field) => [field] as const),
  ['packages', '*'],
  ['providers', '*'],
];

function streamError(error: unknown): unknown {
  if (error instanceof JsonExtractError) {
    return error.code === 'document_too_large' || error.code === 'member_too_large'
      ? new ComposerRootError('too_large')
      : new ComposerRootError('invalid', 'body');
  }
  if (error instanceof JsonStreamError) {
    return new ComposerRootError('invalid', 'body');
  }
  return error;
}

async function* rootChunks(
  body: ReadableStream<Uint8Array>,
  maxDocumentBytes: number,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const prefix = new Uint8Array(3);
  let prefixLength = 0;
  let started = false;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxDocumentBytes) throw new ComposerRootError('too_large');
      if (started) {
        yield value;
        continue;
      }
      const take = Math.min(3 - prefixLength, value.byteLength);
      prefix.set(value.subarray(0, take), prefixLength);
      prefixLength += take;
      if (prefixLength < 3) continue;
      started = true;
      if (prefix[0] !== 0xef || prefix[1] !== 0xbb || prefix[2] !== 0xbf) yield prefix;
      if (value.byteLength > take) yield value.subarray(take);
    }
    if (!started && prefixLength > 0) yield prefix.subarray(0, prefixLength);
  } finally {
    try {
      await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }
}

async function streamRoot(
  body: ReadableStream<Uint8Array>,
  streaming: ComposerRootStreaming,
  retainedLimit: number,
): Promise<{ root: Json; sha256: string }> {
  const tap = streaming.codecs.digestTap(['sha256']);
  tap.digests.catch(() => undefined);
  const root: Json = {};
  const encoder = new TextEncoder();
  const maxMemberBytes = streaming.maxMemberBytes ?? DEFAULT_MAX_BYTES;
  let retained = 0;
  let packages = false;
  let providers = false;
  try {
    const members = extractMembers(
      rootChunks(body.pipeThrough(tap.transform), streaming.maxDocumentBytes),
      STREAM_SELECTORS,
      {
        maxDocumentBytes: streaming.maxDocumentBytes,
        maxMemberBytes: Math.max(maxMemberBytes, retainedLimit),
      },
    );
    for await (const member of members) {
      const [field] = member.path;
      const size = encoder.encode(member.raw).byteLength;
      if (member.path.length === 2) {
        if (size > maxMemberBytes) throw new ComposerRootError('too_large');
        if (field === 'packages') packages = true;
        else providers = true;
        continue;
      }
      retained += size;
      if (retained > retainedLimit) throw new ComposerRootError('too_large');
      root[field as string] = JSON.parse(member.raw);
    }
    const digest = (await tap.digests).sha256;
    if (packages) root.packages = { inline: true };
    if (providers) root.providers = { inline: true };
    return { root, sha256: toHex(digest) };
  } catch (error) {
    throw streamError(error);
  }
}

export async function readComposerRoot(
  fetch: PolicyFetch,
  source: ComposerRootSource,
  streaming?: ComposerRootStreaming,
): Promise<ComposerRoot> {
  if (streaming !== undefined) {
    for (const value of [
      streaming.maxDocumentBytes,
      streaming.maxMemberBytes ?? DEFAULT_MAX_BYTES,
      source.maxBytes ?? DEFAULT_MAX_BYTES,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new ComposerRootError('invalid', 'limits');
    }
  }
  const allowed = new Set<string>();
  for (const entry of source.allowedOrigins) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
      allowed.add(parsed.origin);
    } catch {
      throw new ComposerRootError('invalid', 'allowedOrigins');
    }
  }
  const check = (url: string, field: string): void => {
    const probe = probeOf(url);
    if (!classifyUrl(probe, source.policy).ok) throw new ComposerRootError('refused', field);
    let origin: string;
    try {
      origin = new URL(probe).origin;
    } catch {
      throw new ComposerRootError('invalid', field);
    }
    if (origin !== rootOrigin && !allowed.has(origin)) throw new ComposerRootError('origin', field);
  };
  const resolved = (template: string, base: string, field: string): string => {
    const url = resolveTemplate(template, base);
    if (url === null) throw new ComposerRootError('invalid', field);
    check(url, field);
    return url;
  };

  let packagesJsonUrl: string;
  try {
    packagesJsonUrl = packagesJsonUrlOf(source.url);
  } catch {
    throw new ComposerRootError('refused', 'url');
  }
  const rootOrigin = new URL(packagesJsonUrl).origin;
  check(packagesJsonUrl, 'url');

  const destinations = [rootOrigin, ...allowed];
  let response: Awaited<ReturnType<PolicyFetch>>;
  let bytes: ArrayBuffer | undefined;
  let streamed: { root: Json; sha256: string } | undefined;
  try {
    response = await fetch({
      url: packagesJsonUrl,
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(source.credential === undefined ? {} : { credential: source.credential }),
      destinations,
      purpose: 'metadata',
      maxBytes: streaming?.maxDocumentBytes ?? source.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: source.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ComposerRootError('http_status', undefined, response.status);
    }
    if (response.body === null) throw new ComposerRootError('invalid', 'body');
    if (streaming === undefined) {
      bytes = await new Response(response.body).arrayBuffer();
    } else {
      streamed = await streamRoot(response.body, streaming, source.maxBytes ?? DEFAULT_MAX_BYTES);
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      throw new ComposerRootError(error.code, error.reason, error.status);
    }
    throw error;
  }

  let root: Json;
  if (streamed === undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ComposerRootError('invalid', 'body');
    }
    if (!isObject(parsed)) throw new ComposerRootError('invalid', 'body');
    root = parsed;
  } else {
    root = streamed.root;
  }

  const base = baseOf(packagesJsonUrl);
  const prefixed = (value: string): string => (value.startsWith('/') ? rootOrigin + value : value);
  const relative = (value: string, field: string): string =>
    resolved(prefixed(value), packagesJsonUrl, field);
  const absolute = (value: string, field: string): string => {
    const text = prefixed(value);
    if (!ABSOLUTE.test(text)) throw new ComposerRootError('invalid', field);
    return resolved(text, packagesJsonUrl, field);
  };
  const includeUrl = (key: string, field: string): string => {
    if (/[?#\\]/.test(key)) throw new ComposerRootError('invalid', field);
    let url: string;
    try {
      url = new URL(`${base}/${key.replace('$', '%24')}`).href;
    } catch {
      throw new ComposerRootError('invalid', field);
    }
    check(url, field);
    return url;
  };

  const hasInline = nonEmptyObject(root.packages);
  const inlineProviders = nonEmptyObject(root.providers);
  const hasProviders =
    nonEmptyString(root['providers-url']) ||
    nonEmptyString(root['providers-lazy-url']) ||
    inlineProviders;

  let mode: ComposerMode;
  let metadataUrl: string | undefined;
  let metadataChangesUrl: string | undefined;
  let providersUrl: string | undefined;
  let providersLazyUrl: string | undefined;
  let providerIncludes: (ComposerRootInclude & { sha256: string })[] | undefined;
  let includes: ComposerRootInclude[] | undefined;
  let availablePackages: string[] | undefined;
  let availablePatterns: string[] | undefined;
  let partialPackages = false;

  if (nonEmptyString(root['metadata-url'])) {
    mode = 'v2';
    metadataUrl = relative(root['metadata-url'], 'metadata-url');
    if (nonEmptyString(root['metadata-changes-url'])) {
      metadataChangesUrl = relative(root['metadata-changes-url'], 'metadata-changes-url');
    }
    availablePackages = stringList(root['available-packages'])?.map((n) => n.toLowerCase());
    availablePatterns = stringList(root['available-package-patterns']);
    partialPackages = hasInline;
  } else if (hasProviders) {
    if (nonEmptyString(root['providers-url'])) {
      mode = 'v1-providers';
      providersUrl = absolute(root['providers-url'], 'providers-url');
      if (nonEmptyString(root['providers-lazy-url'])) {
        providersLazyUrl = absolute(root['providers-lazy-url'], 'providers-lazy-url');
        partialPackages = hasInline;
      }
      const listed = root['provider-includes'];
      if (isObject(listed)) {
        const entries = Object.entries(listed);
        if (entries.length > MAX_INCLUDES)
          throw new ComposerRootError('invalid', 'provider-includes');
        providerIncludes = entries.map(([key, value]) => {
          const hash = isObject(value) ? value.sha256 : undefined;
          if (typeof hash !== 'string' || !SHA256.test(hash)) {
            throw new ComposerRootError('invalid', 'provider-includes');
          }
          const sha256 = hash.toLowerCase();
          return {
            url: includeUrl(key.replaceAll('%hash%', sha256), 'provider-includes'),
            sha256,
          };
        });
      }
    } else if (nonEmptyString(root['providers-lazy-url'])) {
      mode = 'v1-lazy';
      providersLazyUrl = absolute(root['providers-lazy-url'], 'providers-lazy-url');
      partialPackages = hasInline;
    } else {
      throw new ComposerRootError('unsupported', 'providers');
    }
  } else {
    mode = 'v1-includes';
  }

  if (mode === 'v1-includes' && isObject(root.includes)) {
    const entries = Object.entries(root.includes);
    if (entries.length > MAX_INCLUDES) throw new ComposerRootError('invalid', 'includes');
    includes = entries.map(([key, value]) => {
      const entry = isObject(value) ? value : {};
      const sha1 = typeof entry.sha1 === 'string' && SHA1.test(entry.sha1) ? entry.sha1 : undefined;
      const sha256 =
        typeof entry.sha256 === 'string' && SHA256.test(entry.sha256) ? entry.sha256 : undefined;
      return {
        url: includeUrl(key, 'includes'),
        ...(sha1 === undefined ? {} : { sha1: sha1.toLowerCase() }),
        ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }),
      };
    });
  }

  const { mirrors, refused } = mirrorsOf(root.mirrors, prefixed, resolved, packagesJsonUrl);
  const messages = messagesOf(root);
  if (refused > 0) messages.push({ type: 'warning', message: 'mirror_refused' });

  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;

  return {
    mode,
    packagesJsonUrl,
    ...(metadataUrl === undefined ? {} : { metadataUrl }),
    ...(metadataChangesUrl === undefined ? {} : { metadataChangesUrl }),
    ...(providersUrl === undefined ? {} : { providersUrl }),
    ...(providersLazyUrl === undefined ? {} : { providersLazyUrl }),
    ...(providerIncludes === undefined ? {} : { providerIncludes }),
    ...(includes === undefined ? {} : { includes }),
    inlineProviders,
    partialPackages,
    inlinePackages: hasInline,
    ...(availablePackages === undefined ? {} : { availablePackages }),
    ...(availablePatterns === undefined ? {} : { availablePatterns }),
    validator: {
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      sha256:
        streamed?.sha256 ?? toHex(await crypto.subtle.digest('SHA-256', bytes as ArrayBuffer)),
    },
    messages,
    mirrors,
  };
}
