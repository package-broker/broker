import { matchesPattern } from '../../catalogue/patterns.js';
import type { Codecs } from '../../platform/codec.js';
import type { ComposerRepositoryConfig } from '../../sources/config.js';
import { UpstreamError, type PolicyFetch } from '../../sources/policy-fetch.js';
import {
  JsonExtractError,
  extractMembers,
  type ExtractedMember,
  type MemberSelector,
} from '../json-stream.js';
import { JsonStreamError, JsonTokenizer, type JsonToken } from '../json-tokenizer.js';
import {
  ComposerRootError,
  readComposerRoot,
  type ComposerMode,
  type ComposerRoot,
  type ComposerRootInclude,
  type ComposerRootSource,
} from './root.js';

/** The document an inline package was read from, with the hashes it must match. */
export interface V1IndexDocument {
  readonly url: string;
  readonly sha1?: string;
  readonly sha256?: string;
}

/**
 * A document of the pass whose hashes matched, with the raw values of the packages it kept by
 * lowercased key. `partial` means some packages were not kept (outside the selection or over the
 * cache budget), so a missing name is unknown rather than absent.
 */
export interface V1CachedDocument {
  readonly members: ReadonlyMap<string, string>;
  readonly partial: boolean;
}

/** Verified documents of one index pass, keyed by `documentKey`. */
export type V1DocumentCache = ReadonlyMap<string, V1CachedDocument>;

export function isSelected(key: string, selection: ComposerRepositoryConfig['selection']): boolean {
  return selection.packages.includes(key) || selection.patterns.some((p) => matchesPattern(p, key));
}

export const documentKey = (document: V1IndexDocument): string =>
  `${document.url}\n${document.sha1 ?? ''}\n${document.sha256 ?? ''}`;

export type V1IndexEntry =
  | {
      /** The listed provider-file hash. */
      readonly kind: 'provider';
      readonly sha256: string;
    }
  | {
      /** SHA-256 of the package's inline versions as written in `document`. */
      readonly kind: 'package';
      readonly sha256: string;
      readonly document: V1IndexDocument;
    };

export type V1IndexFailure =
  | 'hash'
  | 'status'
  | 'read'
  | 'invalid'
  | 'name'
  | 'duplicate'
  | 'limit'
  | 'bytes'
  | 'deadline'
  | 'root';

export interface V1Index {
  readonly rootSha256: string;
  readonly mode: Exclude<ComposerMode, 'v2'>;
  /** False means the pass failed twice: keep the previous listing. */
  readonly complete: boolean;
  /** Why the last pass failed; set only when the index is incomplete. */
  readonly reason?: V1IndexFailure;
  /** Lowercased package name to entry; empty when the index is incomplete. */
  readonly entries: ReadonlyMap<string, V1IndexEntry>;
  /** Verified documents of this pass; empty when the index is incomplete. */
  readonly documents: V1DocumentCache;
}

export interface V1IndexPrevious {
  readonly rootSha256: string;
  readonly complete: boolean;
}

export interface V1IndexOptions {
  readonly source: ComposerRootSource;
  readonly codecs: Pick<Codecs, 'digestTap'>;
  readonly signal?: AbortSignal;
  /** Only these names are kept in `V1Index.documents`; every name when absent. */
  readonly selection?: ComposerRepositoryConfig['selection'];
  /** Raw package text `V1Index.documents` may hold across the pass. Default 8 MiB. */
  readonly maxCachedBytes?: number;
  /** Largest include or streamed root body. Default 32 MiB. */
  readonly maxDocumentBytes?: number;
  /** Largest single package or provider member. Default 1 MiB. */
  readonly maxMemberBytes?: number;
  /** Bytes one pass may download across all documents. Default 128 MiB. */
  readonly maxPassBytes?: number;
  /** Wall-clock budget of one pass. Default 120 s. */
  readonly passTimeoutMs?: number;
  /** At most 200,000 (the default). */
  readonly maxEntries?: number;
  /** Documents per pass, the streamed root included. At most 1000 (the default). */
  readonly maxFiles?: number;
  /** Include nesting depth. At most 8 (the default). */
  readonly maxDepth?: number;
}

export type V1IndexResult =
  | { readonly status: 'not_modified'; readonly root: ComposerRoot }
  | { readonly status: 'updated'; readonly root: ComposerRoot; readonly index: V1Index };

const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MEMBER_BYTES = 1024 * 1024;
const DEFAULT_MAX_PASS_BYTES = 128 * 1024 * 1024;
const DEFAULT_PASS_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_CACHED_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_DEPTH = 8;
/**
 * The index is held whole in one Workers isolate (128 MB). A name plus its entry costs roughly
 * 150-250 bytes in V8, so 200,000 entries stay under ~50 MB with room for the stream buffers;
 * repo.magento.com lists about 21,000 and wpackagist about 120,000.
 */
const MAX_ENTRIES = 200_000;
const CONTAINER_KEY_BYTES = 64 * 1024;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const PACKAGE_NAME = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]|-{1,2})?[a-z0-9]+)*$/;

class IncludeFailure extends Error {
  override readonly name = 'IncludeFailure';
  constructor(readonly code: V1IndexFailure) {
    super(`v1 index ${code}`);
  }
}

interface Expected {
  readonly sha1?: string;
  readonly sha256?: string;
}

interface Limits {
  readonly maxDocumentBytes: number;
  readonly maxMemberBytes: number;
  readonly maxPassBytes: number;
  readonly passTimeoutMs: number;
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxCachedBytes: number;
}

interface Pass {
  readonly fetch: PolicyFetch;
  readonly options: V1IndexOptions;
  readonly limits: Limits;
  readonly destinations: readonly string[];
  readonly base: string;
  readonly deadline: number;
  expired?: AbortSignal;
  readonly entries: Map<string, V1IndexEntry>;
  readonly documents: Map<string, V1CachedDocument>;
  cacheBytes: number;
  files: number;
  bytes: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

export async function sha256Of(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function limit(name: string, value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new RangeError(`${name} must be a positive integer up to ${max}`);
  }
  return resolved;
}

function limitsOf(options: V1IndexOptions): Limits {
  const any = Number.MAX_SAFE_INTEGER;
  return {
    maxDocumentBytes: limit(
      'maxDocumentBytes',
      options.maxDocumentBytes,
      DEFAULT_MAX_DOCUMENT_BYTES,
      any,
    ),
    maxMemberBytes: limit('maxMemberBytes', options.maxMemberBytes, DEFAULT_MAX_MEMBER_BYTES, any),
    maxPassBytes: limit('maxPassBytes', options.maxPassBytes, DEFAULT_MAX_PASS_BYTES, any),
    passTimeoutMs: limit('passTimeoutMs', options.passTimeoutMs, DEFAULT_PASS_TIMEOUT_MS, any),
    maxEntries: limit('maxEntries', options.maxEntries, MAX_ENTRIES, MAX_ENTRIES),
    maxFiles: limit('maxFiles', options.maxFiles, MAX_FILES, MAX_FILES),
    maxDepth: limit('maxDepth', options.maxDepth, MAX_DEPTH, MAX_DEPTH),
    maxCachedBytes: limit('maxCachedBytes', options.maxCachedBytes, DEFAULT_MAX_CACHED_BYTES, any),
  };
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new IncludeFailure('invalid');
  }
}

function nameOf(name: string): string {
  const lower = name.toLowerCase();
  if (!PACKAGE_NAME.test(lower)) throw new IncludeFailure('name');
  return lower;
}

function baseOf(packagesJsonUrl: string): string {
  const parsed = new URL(packagesJsonUrl);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, '');
  return parsed.href.replace(/\/+$/, '');
}

function nestedIncludes(pass: Pass, raw: string): (ComposerRootInclude & Expected)[] {
  const listed = parse(raw);
  if (Array.isArray(listed) && listed.length === 0) return [];
  if (!isObject(listed)) throw new IncludeFailure('invalid');
  return Object.entries(listed).map(([key, value]) => {
    if (/[?#\\]/.test(key)) throw new IncludeFailure('invalid');
    let url: string;
    try {
      url = new URL(`${pass.base}/${key.replaceAll('$', '%24')}`).href;
    } catch {
      throw new IncludeFailure('invalid');
    }
    if (!url.startsWith(`${pass.base}/`)) throw new IncludeFailure('invalid');
    const entry = isObject(value) ? value : {};
    const sha1 = typeof entry.sha1 === 'string' && SHA1.test(entry.sha1) ? entry.sha1 : undefined;
    const sha256 =
      typeof entry.sha256 === 'string' && SHA256.test(entry.sha256) ? entry.sha256 : undefined;
    return {
      url,
      ...(sha1 === undefined ? {} : { sha1: sha1.toLowerCase() }),
      ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }),
    };
  });
}

function providerEntry(raw: string): V1IndexEntry {
  const value = parse(raw);
  const hash = isObject(value) ? value.sha256 : undefined;
  if (typeof hash !== 'string' || !SHA256.test(hash)) throw new IncludeFailure('invalid');
  return { kind: 'provider', sha256: hash.toLowerCase() };
}

async function packageEntry(raw: string, document: V1IndexDocument): Promise<V1IndexEntry | null> {
  const value = parse(raw);
  if (Array.isArray(value) && value.length === 0) return null;
  if (!isObject(value)) throw new IncludeFailure('invalid');
  if (Object.keys(value).length === 0) return null;
  return { kind: 'package', sha256: await sha256Of(raw), document };
}

function aborted(options: V1IndexOptions): void {
  options.signal?.throwIfAborted();
}

async function guarded<T>(pass: Pass, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    aborted(pass.options);
    if (pass.expired?.aborted === true) throw new IncludeFailure('deadline');
    if (error instanceof IncludeFailure) throw error;
    if (
      error instanceof UpstreamError ||
      error instanceof JsonExtractError ||
      error instanceof JsonStreamError ||
      error instanceof TypeError
    ) {
      throw new IncludeFailure(Date.now() >= pass.deadline ? 'deadline' : 'read');
    }
    throw error;
  }
}

const isNoise = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x3a;

/**
 * The member extractor silently passes over a selected container that is an array or a scalar,
 * so the top-level `sections` are checked here: an object, or an empty array (PHP's encoding of
 * an empty map). Values are skipped by the tokenizer; the type comes from the first value bytes.
 */
function containerCheck(sections: readonly string[]): TransformStream<Uint8Array, Uint8Array> {
  const tokenizer = new JsonTokenizer({ maxStringBytes: CONTAINER_KEY_BYTES });
  const watches: { from: number; seen: number[] }[] = [];
  let depth = 0;
  let offset = 0;
  const sink = (token: JsonToken): void => {
    if (depth === 0) {
      if (token.type === 'beginObject') depth = 1;
    } else if (token.type === 'key') {
      if (sections.includes(token.value)) watches.push({ from: token.end, seen: [] });
      tokenizer.skipNext();
    } else if (token.type === 'endObject') {
      depth = 0;
    }
  };
  const settle = (final: boolean): void => {
    for (let index = watches.length - 1; index >= 0; index -= 1) {
      const [first, second] = (watches[index] as { seen: number[] }).seen;
      if (first === 0x7b || (first === 0x5b && second === 0x5d)) watches.splice(index, 1);
      else if (final || (first !== undefined && (first !== 0x5b || second !== undefined))) {
        throw new IncludeFailure('invalid');
      }
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      tokenizer.write(chunk, sink);
      for (const watch of watches) {
        for (let i = Math.max(watch.from - offset, 0); i < chunk.length; i += 1) {
          if (watch.seen.length >= 2) break;
          const byte = chunk[i] as number;
          if (!isNoise(byte)) watch.seen.push(byte);
        }
      }
      offset += chunk.length;
      settle(false);
      controller.enqueue(chunk);
    },
    flush() {
      tokenizer.end(() => undefined);
      settle(true);
    },
  });
}

function budget(pass: Pass): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      pass.bytes += chunk.byteLength;
      if (pass.bytes > pass.limits.maxPassBytes) throw new IncludeFailure('bytes');
      controller.enqueue(chunk);
    },
  });
}

async function readDocument(
  pass: Pass,
  url: string,
  expected: Expected,
  selectors: readonly MemberSelector[],
  depth: number,
): Promise<void> {
  aborted(pass.options);
  if (expected.sha1 === undefined && expected.sha256 === undefined) {
    throw new IncludeFailure('hash');
  }
  pass.files += 1;
  if (pass.files > pass.limits.maxFiles || depth > pass.limits.maxDepth) {
    throw new IncludeFailure('limit');
  }
  const remaining = pass.deadline - Date.now();
  if (remaining <= 0 || pass.expired?.aborted === true) throw new IncludeFailure('deadline');
  const { source, codecs, signal } = pass.options;
  // Classify the deadline by its timer: the wall clock can lag when a fetch is aborted.
  if (pass.expired === undefined && remaining <= MAX_TIMER_MS) {
    pass.expired = AbortSignal.timeout(remaining);
  }
  const abort = [signal, pass.expired].filter((s): s is AbortSignal => s !== undefined);
  const algs = [
    ...(expected.sha1 === undefined ? [] : (['sha1'] as const)),
    ...(expected.sha256 === undefined ? [] : (['sha256'] as const)),
  ];
  const response = await guarded(pass, () =>
    pass.fetch({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(source.credential === undefined ? {} : { credential: source.credential }),
      destinations: pass.destinations,
      purpose: 'metadata',
      maxBytes: pass.limits.maxDocumentBytes,
      timeoutMs: Math.min(source.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMER_MS),
      ...(abort.length === 0
        ? {}
        : { signal: abort.length === 1 ? abort[0] : AbortSignal.any(abort) }),
    }),
  );
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new IncludeFailure('status');
  }
  const tap = codecs.digestTap(algs);
  tap.digests.catch(() => undefined);
  const members = extractMembers(
    response.body
      .pipeThrough(budget(pass))
      .pipeThrough(
        containerCheck(selectors.filter((s) => s.length === 2).map((s) => s[0] as string)),
      )
      .pipeThrough(tap.transform),
    selectors,
    { maxDocumentBytes: pass.limits.maxDocumentBytes, maxMemberBytes: pass.limits.maxMemberBytes },
  );
  const document: V1IndexDocument = {
    url,
    ...(expected.sha1 === undefined ? {} : { sha1: expected.sha1 }),
    ...(expected.sha256 === undefined ? {} : { sha256: expected.sha256 }),
  };
  const staged = new Map<string, V1IndexEntry>();
  const names = new Set<string>();
  const nested: (ComposerRootInclude & Expected)[] = [];
  const kept = new Map<string, string>();
  let keptBytes = 0;
  let partial = false;
  try {
    for (;;) {
      const step: IteratorResult<ExtractedMember> = await guarded(pass, () => members.next());
      if (step.done === true) break;
      const [section, key = ''] = step.value.path;
      if (section === 'includes') {
        nested.push(...nestedIncludes(pass, step.value.raw));
        continue;
      }
      const name = nameOf(key);
      if (section === 'packages') {
        const { selection } = pass.options;
        if (
          (selection !== undefined && !isSelected(name, selection)) ||
          pass.cacheBytes - keptBytes < step.value.raw.length
        ) {
          partial = true;
        } else {
          kept.set(name, step.value.raw);
          keptBytes += step.value.raw.length;
        }
      }
      const entry =
        section === 'providers'
          ? providerEntry(step.value.raw)
          : await packageEntry(step.value.raw, document);
      if (entry === null) continue;
      if (names.has(name)) throw new IncludeFailure('duplicate');
      names.add(name);
      const previous = pass.entries.get(name);
      if (previous !== undefined) {
        if (previous.kind !== entry.kind || previous.sha256 !== entry.sha256) {
          throw new IncludeFailure('duplicate');
        }
        continue;
      }
      if (pass.entries.size + staged.size >= pass.limits.maxEntries) {
        throw new IncludeFailure('limit');
      }
      staged.set(name, entry);
    }
  } finally {
    await members.return(undefined).catch(() => undefined);
  }
  const digests: Partial<Record<'sha1' | 'sha256', Uint8Array>> = await guarded(
    pass,
    () => tap.digests,
  );
  for (const alg of algs) {
    const digest = digests[alg];
    if (digest === undefined || hex(digest) !== expected[alg]) throw new IncludeFailure('hash');
  }
  pass.documents.set(documentKey(document), { members: kept, partial });
  pass.cacheBytes -= keptBytes;
  for (const [name, entry] of staged) pass.entries.set(name, entry);
  for (const include of nested) {
    await readDocument(pass, include.url, include, [['packages', '*'], ['includes']], depth + 1);
  }
}

function rootSelectors(root: ComposerRoot): MemberSelector[] {
  const selectors: MemberSelector[] = [];
  if (root.inlineProviders) selectors.push(['providers', '*']);
  if (root.mode === 'v1-includes' || root.partialPackages) selectors.push(['packages', '*']);
  return selectors;
}

type PassOutcome =
  | {
      readonly entries: Map<string, V1IndexEntry>;
      readonly documents: Map<string, V1CachedDocument>;
    }
  | { readonly failure: V1IndexFailure };

async function indexPass(
  fetch: PolicyFetch,
  options: V1IndexOptions,
  limits: Limits,
  root: ComposerRoot,
  rootBytes: number,
  deadline: number,
): Promise<PassOutcome> {
  const pass: Pass = {
    fetch,
    options,
    limits,
    destinations: [
      new URL(root.packagesJsonUrl).origin,
      ...options.source.allowedOrigins.map((origin) => new URL(origin).origin),
    ],
    base: baseOf(root.packagesJsonUrl),
    deadline,
    entries: new Map(),
    documents: new Map(),
    cacheBytes: limits.maxCachedBytes,
    files: 0,
    bytes: rootBytes,
  };
  try {
    if (pass.bytes > limits.maxPassBytes) throw new IncludeFailure('bytes');
    if (Date.now() >= deadline) throw new IncludeFailure('deadline');
    const selectors = rootSelectors(root);
    if (selectors.length > 0) {
      await readDocument(
        pass,
        root.packagesJsonUrl,
        { sha256: root.validator.sha256 },
        selectors,
        0,
      );
    }
    for (const include of root.providerIncludes ?? []) {
      await readDocument(pass, include.url, include, [['providers', '*']], 0);
    }
    for (const include of root.includes ?? []) {
      await readDocument(pass, include.url, include, [['packages', '*'], ['includes']], 0);
    }
  } catch (error) {
    if (error instanceof IncludeFailure) return { failure: error.code };
    throw error;
  }
  return { entries: pass.entries, documents: pass.documents };
}

interface RootRead {
  readonly root: ComposerRoot;
  readonly bytes: number;
}

async function readV1Root(
  fetch: PolicyFetch,
  options: V1IndexOptions,
  limits: Limits,
  deadline: number,
): Promise<RootRead> {
  let bytes = 0;
  const counted: PolicyFetch = async (request) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ComposerRootError('timeout');
    const response = await fetch({
      ...request,
      timeoutMs: Math.min(request.timeoutMs, remaining),
    });
    if (response.body === null) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    return { status: response.status, headers: response.headers, body };
  };
  const root = await readComposerRoot(counted, options.source, {
    codecs: options.codecs,
    maxDocumentBytes: limits.maxDocumentBytes,
    maxMemberBytes: limits.maxMemberBytes,
  });
  if (root.mode === 'v2') throw new ComposerRootError('unsupported', 'metadata-url');
  return { root, bytes };
}

function updated(root: ComposerRoot, rootSha256: string, outcome: PassOutcome): V1IndexResult {
  return {
    status: 'updated',
    root,
    index: {
      rootSha256,
      mode: root.mode as V1Index['mode'],
      ...('entries' in outcome
        ? { complete: true, entries: outcome.entries, documents: outcome.documents }
        : { complete: false, reason: outcome.failure, entries: new Map(), documents: new Map() }),
    },
  };
}

/**
 * Lists every package of a Composer v1 repository. An unchanged root hash after a complete
 * index costs one request; otherwise every include is fetched and verified again. A failed
 * include re-reads packages.json once and repeats the pass; a second failure, including a
 * failed second root read, yields an incomplete index.
 */
export async function readV1Index(
  fetch: PolicyFetch,
  options: V1IndexOptions,
  previous?: V1IndexPrevious,
): Promise<V1IndexResult> {
  const limits = limitsOf(options);
  aborted(options);
  const { signal } = options;
  const send: PolicyFetch =
    signal === undefined ? fetch : (request) => fetch({ ...request, signal });
  const firstDeadline = Date.now() + limits.passTimeoutMs;
  const { root: first, bytes: firstBytes } = await readV1Root(send, options, limits, firstDeadline);
  if (previous?.complete === true && previous.rootSha256 === first.validator.sha256) {
    return { status: 'not_modified', root: first };
  }
  const outcome = await indexPass(fetch, options, limits, first, firstBytes, firstDeadline);
  if ('entries' in outcome || firstBytes > limits.maxPassBytes)
    return updated(first, first.validator.sha256, outcome);
  let again: RootRead;
  const retryDeadline = Date.now() + limits.passTimeoutMs;
  try {
    again = await readV1Root(send, options, limits, retryDeadline);
  } catch (error) {
    aborted(options);
    if (error instanceof ComposerRootError) {
      return updated(first, first.validator.sha256, { failure: 'root' });
    }
    throw error;
  }
  const { root, bytes } = again;
  return updated(
    root,
    root.validator.sha256,
    await indexPass(fetch, options, limits, root, bytes, retryDeadline),
  );
}
