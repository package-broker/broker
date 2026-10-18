import { PackageNameError, packageKey } from '../../catalogue/names.js';
import { matchesPattern } from '../../catalogue/patterns.js';
import type { Codecs } from '../../platform/codec.js';
import {
  composerVersionInput,
  type ComposerVersionOrigin,
  type ComposerVersionSkip,
} from '../../registry/composer/version-object.js';
import type { ComposerRepositoryConfig } from '../../sources/config.js';
import { UPSTREAM_DEFAULTS } from '../../sources/config.js';
import { UpstreamError, type PolicyFetch } from '../../sources/policy-fetch.js';
import {
  createPackageDescription,
  snapshotRef,
  type DescribeFound,
  type DescribeResult,
  type FormEvidence,
  type SnapshotRef,
  type VersionCandidate,
} from '../../sources/provider.js';
import { JsonExtractError, extractMembers } from '../json-stream.js';
import { JsonStreamError, JsonTokenizer, type JsonToken } from '../json-tokenizer.js';
import { retryAfterOf } from './retry-after.js';
import type { ComposerRoot, ComposerRootSource } from './root.js';
import type { V1Index, V1IndexEntry } from './v1-index.js';

export type ComposerV1PackageErrorCode =
  'name' | 'invalid' | 'hash' | 'status' | 'unsupported' | 'too_large' | 'deadline';

export class ComposerV1PackageError extends Error {
  override readonly name = 'ComposerV1PackageError';
  constructor(
    readonly code: ComposerV1PackageErrorCode,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`composer v1 package ${code}${status === undefined ? '' : ` (${status})`}`);
  }
}

export type V1PackageSkip = ComposerVersionSkip | 'duplicate';

export interface V1PackageOptions {
  readonly source: ComposerRootSource;
  readonly root: ComposerRoot;
  /** The listing and its completeness; required to prove a selected name absent. */
  readonly index?: Pick<V1Index, 'complete' | 'entries'>;
  /** The name's entry, when supplied separately from the index. */
  readonly entry?: V1IndexEntry;
  readonly selection: ComposerRepositoryConfig['selection'];
  readonly origin: ComposerVersionOrigin;
  readonly codecs: Pick<Codecs, 'digestTap'>;
  /** SHA-256 of the provider file last ingested. */
  readonly previousSha256?: string;
  /** Bytes all attempts may download together; at most the metadata cap (32 MiB). */
  readonly maxBytes?: number;
  /** Version objects one provider file may hold. Default 10,000. */
  readonly maxVersions?: number;
  /** Wall-clock budget shared by all attempts. Default 60 s. */
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export type V1PackageResult =
  | Exclude<DescribeResult, DescribeFound>
  | (DescribeFound & { readonly skipped: Readonly<Partial<Record<V1PackageSkip, number>>> });

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_MAX_VERSIONS = 10_000;
const MAX_MEMBER_BYTES = 1024 * 1024;
const KEY_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

interface Budget {
  bytes: number;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
}

interface Parsed {
  readonly hash: string;
  readonly candidates: VersionCandidate[];
  readonly skipped: Partial<Record<V1PackageSkip, number>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function keyOf(name: string): string {
  try {
    return packageKey(name, { ecosystem: 'composer' });
  } catch (error) {
    if (error instanceof PackageNameError) throw new ComposerV1PackageError('name');
    throw error;
  }
}

function selected(key: string, selection: ComposerRepositoryConfig['selection']): boolean {
  return selection.packages.includes(key) || selection.patterns.some((p) => matchesPattern(p, key));
}

function fill(template: string, key: string, hash = ''): string {
  try {
    return new URL(
      template.replaceAll('%package%', key).replaceAll('%hash%', hash).replaceAll('$', '%24'),
    ).href;
  } catch {
    throw new ComposerV1PackageError('invalid');
  }
}

function originsOf(options: V1PackageOptions): string[] {
  try {
    return [
      new URL(options.root.packagesJsonUrl).origin,
      ...options.source.allowedOrigins.map((o) => new URL(o).origin),
    ];
  } catch {
    throw new ComposerV1PackageError('invalid');
  }
}

/**
 * The member extractor passes over a `packages` value, or a package value, that is not an object,
 * so the shape is checked here: objects, or an empty array (PHP's encoding of an empty map).
 */
function shapeCheck(): TransformStream<Uint8Array, Uint8Array> {
  const tokenizer = new JsonTokenizer({ maxStringBytes: KEY_BYTES });
  type State =
    'root' | 'packages' | 'emptyPackages' | 'map' | 'package' | 'emptyPackage' | 'versions';
  let state: State = 'root';
  let depth = 0;
  let sawPackages = false;
  const invalid = (): never => {
    throw new ComposerV1PackageError('invalid');
  };
  const container = (token: JsonToken, inside: State, empty: State): State => {
    if (token.type === 'beginObject') return inside;
    if (token.type === 'beginArray') return empty;
    return invalid();
  };
  const sink = (token: JsonToken): void => {
    switch (state) {
      case 'root':
        if (token.type === 'beginObject' || token.type === 'beginArray') depth += 1;
        else if (token.type === 'endObject' || token.type === 'endArray') depth -= 1;
        else if (token.type === 'key' && depth === 1) {
          if (token.value === 'packages') {
            sawPackages = true;
            tokenizer.structureOnlyNext();
            state = 'packages';
          } else {
            tokenizer.skipNext();
          }
        }
        return;
      case 'packages':
        state = container(token, 'map', 'emptyPackages');
        return;
      case 'emptyPackages':
        state = token.type === 'endArray' ? 'root' : invalid();
        return;
      case 'map':
        state = token.type === 'key' ? 'package' : 'root';
        return;
      case 'package':
        state = container(token, 'versions', 'emptyPackage');
        return;
      case 'emptyPackage':
        state = token.type === 'endArray' ? 'map' : invalid();
        return;
      case 'versions':
        if (token.type === 'key') tokenizer.skipNext();
        else state = 'map';
        return;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      tokenizer.write(chunk, sink);
      controller.enqueue(chunk);
    },
    flush() {
      tokenizer.end(sink);
      if (!sawPackages) invalid();
    },
  });
}

function counted(budget: Budget): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      budget.bytes -= chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

const SIZE_CODES: ReadonlySet<string> = new Set([
  'member_too_large',
  'document_too_large',
  'too_many_members',
  'token_too_large',
  'depth_exceeded',
]);

/**
 * Runs one fetch or extraction step and classifies its failure. A TypeError here can only be a
 * UTF-8 decode failure of the tokenizer or extractor; anywhere else it propagates.
 */
async function upstream<T>(budget: Budget, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    budget.signal?.throwIfAborted();
    if (error instanceof UpstreamError) {
      if (error.code === 'too_large') throw new ComposerV1PackageError('too_large');
      if (error.code === 'timeout' && Date.now() >= budget.deadline) {
        throw new ComposerV1PackageError('deadline');
      }
      throw error;
    }
    if (error instanceof JsonExtractError || error instanceof JsonStreamError) {
      throw new ComposerV1PackageError(SIZE_CODES.has(error.code) ? 'too_large' : 'invalid');
    }
    if (error instanceof TypeError) throw new ComposerV1PackageError('invalid');
    throw error;
  }
}

function retryAfterHeader(headers: Headers): number | undefined {
  return retryAfterOf(headers.get('retry-after'), Date.now());
}

async function readOnce(
  fetch: PolicyFetch,
  url: string,
  key: string,
  options: V1PackageOptions,
  budget: Budget,
): Promise<Parsed | null> {
  const { source, signal } = options;
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) throw new ComposerV1PackageError('deadline');
  if (budget.bytes <= 0) throw new ComposerV1PackageError('too_large');
  const response = await upstream(budget, () =>
    fetch({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(source.credential === undefined ? {} : { credential: source.credential }),
      destinations: originsOf(options),
      purpose: 'metadata',
      maxBytes: budget.bytes,
      timeoutMs: Math.min(source.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining),
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return null;
    throw new ComposerV1PackageError(
      'status',
      response.status,
      response.status === 429 ? retryAfterHeader(response.headers) : undefined,
    );
  }
  const tap = options.codecs.digestTap(['sha256']);
  tap.digests.catch(() => undefined);
  const members = extractMembers(
    response.body.pipeThrough(counted(budget)).pipeThrough(shapeCheck()).pipeThrough(tap.transform),
    [['packages', '*', '*']],
    { maxDocumentBytes: UPSTREAM_DEFAULTS.metadataMaxBytes, maxMemberBytes: MAX_MEMBER_BYTES },
  );
  const maxVersions = options.maxVersions ?? DEFAULT_MAX_VERSIONS;
  const candidates: VersionCandidate[] = [];
  const skipped: Partial<Record<V1PackageSkip, number>> = {};
  const skip = (reason: V1PackageSkip): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  let objects = 0;
  try {
    for (;;) {
      const step = await upstream(budget, () => members.next());
      if (step.done === true) break;
      objects += 1;
      if (objects > maxVersions) throw new ComposerV1PackageError('too_large');
      const object = JSON.parse(step.value.raw) as unknown;
      if (!isRecord(object)) {
        skip('malformed');
        continue;
      }
      if (typeof object.name !== 'string' || object.name.toLowerCase() !== key) {
        skip('foreign_name');
        continue;
      }
      const result = composerVersionInput(key, object, options.origin);
      if (!result.ok) {
        skip(result.reason);
        continue;
      }
      const { input } = result;
      if (seen.has(input.versionNormalized)) {
        skip('duplicate');
        continue;
      }
      seen.add(input.versionNormalized);
      const dev =
        input.versionNormalized.startsWith('dev-') || input.versionNormalized.endsWith('-dev');
      candidates.push({
        ordinal: objects - 1,
        version: input.version,
        form: dev ? 'composer-p2-dev' : 'composer-p2',
        ...(input.upstreamReleasedAt === null ? {} : { upstreamTime: input.upstreamReleasedAt }),
        raw: input.metadata.json,
      });
    }
  } finally {
    await members.return(undefined).catch(() => undefined);
  }
  const digests = await tap.digests;
  return { hash: hex(digests.sha256), candidates, skipped };
}

function found(key: string, parsed: Parsed): V1PackageResult {
  const snapshot: SnapshotRef = snapshotRef(`sha256:${parsed.hash}`);
  const forms: FormEvidence[] = (['composer-p2', 'composer-p2-dev'] as const).map((form) => ({
    form,
    status: 'present',
    snapshot,
    validators: {},
  }));
  const { candidates } = parsed;
  const description = createPackageDescription({
    name: key,
    snapshot,
    forms,
    members: (async function* () {
      yield* candidates;
    })(),
    validators: {},
    documentsComplete: true,
  });
  return { kind: 'found', description, skipped: parsed.skipped };
}

async function pause(signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, RETRY_DELAY_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function positive(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/**
 * Describes one package of a Composer v1 repository from its provider file. A listed provider file
 * must match its listed SHA-256 within three attempts that share one byte budget and one deadline;
 * a lazy provider is read only for names in the source selection. Versions are kept by the
 * object's own `name`, as Composer does, and nothing is yielded before the digest is known.
 * Without a lazy lookup, an unlisted name is definitive only in a complete, non-empty index.
 * Unlisted names outside the source selection return definitive not_found as a caller selection
 * decision, not an upstream proof.
 */
export async function describeComposerV1(
  fetch: PolicyFetch,
  name: string,
  options: V1PackageOptions,
): Promise<V1PackageResult> {
  positive('maxBytes', options.maxBytes);
  positive('maxVersions', options.maxVersions);
  positive('deadlineMs', options.deadlineMs);
  const key = keyOf(name);
  const { root, index, signal } = options;
  const entry = options.entry ?? index?.entries.get(key);
  if (root.mode === 'v2') throw new ComposerV1PackageError('unsupported');
  const previous = options.previousSha256?.toLowerCase();
  const budget: Budget = {
    bytes: Math.min(
      options.maxBytes ?? UPSTREAM_DEFAULTS.metadataMaxBytes,
      UPSTREAM_DEFAULTS.metadataMaxBytes,
    ),
    deadline: Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS),
    signal,
  };
  if (entry !== undefined) {
    if (entry.kind !== 'provider' || root.providersUrl === undefined) {
      throw new ComposerV1PackageError('unsupported');
    }
    const hash = entry.sha256.toLowerCase();
    if (!SHA256.test(hash)) throw new ComposerV1PackageError('invalid');
    if (previous === hash) return { kind: 'not_modified' };
    const url = fill(root.providersUrl, key, hash);
    let failure: ComposerV1PackageErrorCode = 'hash';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (attempt > 1) await pause(signal);
      try {
        const parsed = await readOnce(fetch, url, key, options, budget);
        if (parsed === null) return { kind: 'not_found', definitive: false };
        if (parsed.hash === hash) return found(key, parsed);
        failure = 'hash';
      } catch (error) {
        if (!(error instanceof ComposerV1PackageError) || error.code !== 'invalid') throw error;
        failure = 'invalid';
      }
    }
    throw new ComposerV1PackageError(failure);
  }
  if (!selected(key, options.selection)) {
    return { kind: 'not_found', definitive: true };
  }
  if (root.providersLazyUrl === undefined) {
    return { kind: 'not_found', definitive: index?.complete === true && index.entries.size > 0 };
  }
  const parsed = await readOnce(fetch, fill(root.providersLazyUrl, key), key, options, budget);
  if (parsed === null) return { kind: 'not_found', definitive: true };
  if (previous === parsed.hash) return { kind: 'not_modified' };
  return found(key, parsed);
}
