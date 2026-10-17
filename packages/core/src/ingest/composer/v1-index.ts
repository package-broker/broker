import type { Codecs } from '../../platform/codec.js';
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

export interface V1IndexEntry {
  /** `provider`: the listed provider-file hash; `package`: SHA-256 of the inline versions. */
  readonly kind: 'provider' | 'package';
  readonly sha256: string;
}

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
}

export interface V1IndexPrevious {
  readonly rootSha256: string;
  readonly complete: boolean;
}

export interface V1IndexOptions {
  readonly source: ComposerRootSource;
  readonly codecs: Pick<Codecs, 'digestTap'>;
  readonly signal?: AbortSignal;
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
}

interface Pass {
  readonly fetch: PolicyFetch;
  readonly options: V1IndexOptions;
  readonly limits: Limits;
  readonly destinations: readonly string[];
  readonly base: string;
  readonly deadline: number;
  readonly entries: Map<string, V1IndexEntry>;
  files: number;
  bytes: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

async function sha256Of(text: string): Promise<string> {
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

async function packageEntry(raw: string): Promise<V1IndexEntry | null> {
  const value = parse(raw);
  if (Array.isArray(value) && value.length === 0) return null;
  if (!isObject(value)) throw new IncludeFailure('invalid');
  if (Object.keys(value).length === 0) return null;
  return { kind: 'package', sha256: await sha256Of(raw) };
}

function aborted(options: V1IndexOptions): void {
  options.signal?.throwIfAborted();
}

async function guarded<T>(pass: Pass, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    aborted(pass.options);
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
  if (remaining <= 0) throw new IncludeFailure('deadline');
  const { source, codecs, signal } = pass.options;
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
      timeoutMs: Math.min(source.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining),
      ...(signal === undefined ? {} : { signal }),
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
  const staged = new Map<string, V1IndexEntry>();
  const nested: (ComposerRootInclude & Expected)[] = [];
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
      const entry =
        section === 'providers'
          ? providerEntry(step.value.raw)
          : await packageEntry(step.value.raw);
      if (entry === null) continue;
      if (staged.has(name) || pass.entries.has(name)) throw new IncludeFailure('duplicate');
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
  { readonly entries: Map<string, V1IndexEntry> } | { readonly failure: V1IndexFailure };

async function indexPass(
  fetch: PolicyFetch,
  options: V1IndexOptions,
  limits: Limits,
  root: ComposerRoot,
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
    deadline: Date.now() + limits.passTimeoutMs,
    entries: new Map(),
    files: 0,
    bytes: 0,
  };
  try {
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
  return { entries: pass.entries };
}

async function readV1Root(fetch: PolicyFetch, source: ComposerRootSource): Promise<ComposerRoot> {
  const root = await readComposerRoot(fetch, source);
  if (root.mode === 'v2') throw new ComposerRootError('unsupported', 'metadata-url');
  return root;
}

function updated(root: ComposerRoot, rootSha256: string, outcome: PassOutcome): V1IndexResult {
  return {
    status: 'updated',
    root,
    index: {
      rootSha256,
      mode: root.mode as V1Index['mode'],
      ...('entries' in outcome
        ? { complete: true, entries: outcome.entries }
        : { complete: false, reason: outcome.failure, entries: new Map() }),
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
  const first = await readV1Root(send, options.source);
  if (previous?.complete === true && previous.rootSha256 === first.validator.sha256) {
    return { status: 'not_modified', root: first };
  }
  const outcome = await indexPass(send, options, limits, first);
  if ('entries' in outcome) return updated(first, first.validator.sha256, outcome);
  let root: ComposerRoot;
  try {
    root = await readV1Root(send, options.source);
  } catch (error) {
    aborted(options);
    if (error instanceof ComposerRootError) {
      return updated(first, first.validator.sha256, { failure: 'root' });
    }
    throw error;
  }
  return updated(root, root.validator.sha256, await indexPass(send, options, limits, root));
}
