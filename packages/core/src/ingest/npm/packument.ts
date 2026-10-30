import { isRegistryNotFound } from '../not-found-presets.js';
import { packageKey } from '../../catalogue/names.js';
import type { OrgContext } from '../../db/port.js';
import type { CoreBlobStore as BlobStore } from '../../platform/blob.js';
import type { Codecs } from '../../platform/codec.js';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
  type UpstreamResponse,
} from '../../sources/policy-fetch.js';
import {
  createPackageDescription,
  snapshotRef,
  type DescribeOptions,
  type DescribeResult,
  type DocumentValidators,
  type SkippedMember,
  type SnapshotRef,
  type Validators,
  type VersionCandidate,
} from '../../sources/provider.js';
import { extractMembers, type ExtractedMember } from '../json-stream.js';
import { JsonTokenizer, type JsonToken } from '../json-tokenizer.js';
import { openStagedSnapshot, stageSnapshot, type StageSnapshotOptions } from '../snapshot.js';

export const NPM_INLINE_PARSE_BYTES = 1024 * 1024;
export const NPM_VERSION_CHUNK = 50;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const TIME_MEMBER_BYTES = 8 * 1024 * 1024;
const VERSION_MEMBER_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const NOT_FOUND_BODY_BYTES = 64 * 1024;
const MAX_ETAG_ID_LENGTH = 256;
const STRONG_ETAG = /^"[\x21\x23-\x7e]+"$/;

export type NpmPackumentErrorCode = 'invalid' | 'unexpected_status' | 'unstable' | 'snapshot_gone';

export class NpmPackumentError extends Error {
  override readonly name = 'NpmPackumentError';
  constructor(
    readonly code: NpmPackumentErrorCode,
    readonly status?: number,
    readonly packageKey?: string,
  ) {
    super(`npm packument ${code}${status === undefined ? '' : ` (${status})`}`);
  }
}

export interface NpmPackumentDeps {
  readonly ctx: OrgContext;
  readonly fetch: PolicyFetch;
  readonly store: BlobStore;
  readonly codecs: Pick<Codecs, 'digestTap'>;
  readonly onUpstreamBytes?: StageSnapshotOptions['onUpstreamBytes'];
  readonly signal?: AbortSignal;
}

export interface NpmPackumentTarget {
  readonly sourceType?: string;
  readonly name: string;
  readonly url: string;
  readonly credential?: UpstreamCredential;
  readonly destinations?: readonly string[];
  /** Largest packument accepted, staged or not. Default 32 MiB. */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

/**
 * The resumable state of a staged packument: the session persists `validators` with the ref so a
 * continuation reports the validators of the staged bytes.
 */
export interface NpmSnapshotRef extends SnapshotRef {
  readonly validators?: Validators;
  /** Preserved with the staged bytes; missing evidence fails closed on continuation. */
  readonly definitiveAbsence?: boolean;
}

/** `restart`: the staged snapshot is gone; the ingest session must start over (retryable). */
export type NpmDescribeResult = DescribeResult | { readonly kind: 'restart' };

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function validatorsOf(response: UpstreamResponse): Validators {
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  return {
    ...(etag === null ? {} : { etag }),
    ...(lastModified === null ? {} : { lastModified }),
  };
}

function strongEtag(validators: Validators): string | undefined {
  const { etag } = validators;
  return etag !== undefined && etag.length <= MAX_ETAG_ID_LENGTH && STRONG_ETAG.test(etag)
    ? etag
    : undefined;
}

function etagValue(etag: string | undefined): string | undefined {
  return etag?.startsWith('W/') === true ? etag.slice(2) : etag;
}

function sameValidators(left: Validators, right: Validators): boolean {
  return etagValue(left.etag) === etagValue(right.etag) && left.lastModified === right.lastModified;
}

interface Head {
  readonly parts: Uint8Array[];
  readonly size: number;
  /** Set when the body is longer than the limit; it still holds the unread rest. */
  readonly rest: ReadableStreamDefaultReader<Uint8Array> | null;
}

/** Reads until the body ends or passes `limit`; counts the bytes only when it ends or fails. */
async function readHead(
  body: ReadableStream<Uint8Array>,
  limit: number,
  counter: StageSnapshotOptions['onUpstreamBytes'],
): Promise<Head> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        counter?.add(size);
        return { parts, size, rest: null };
      }
      parts.push(value);
      size += value.byteLength;
      if (size > limit) return { parts, size, rest: reader };
    }
  } catch (error) {
    counter?.add(size);
    throw error;
  }
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The whole body again: the parts already read, then the rest of the same response. */
function replay(
  parts: Uint8Array[],
  rest: ReadableStreamDefaultReader<Uint8Array>,
  unpulledBytes: number,
  counter: StageSnapshotOptions['onUpstreamBytes'],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const part = parts.shift();
        if (part !== undefined) {
          unpulledBytes -= part.byteLength;
          controller.enqueue(part);
          return;
        }
        const { done, value } = await rest.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        counter?.add(unpulledBytes);
        unpulledBytes = 0;
        return rest.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function stringRecord(
  raw: string | undefined,
  requireAllStrings = false,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value;
    else if (requireAllStrings) return undefined;
  }
  return out;
}

function invalidPackument(name: string): NpmPackumentError {
  return new NpmPackumentError(
    'invalid',
    undefined,
    packageKey(name, { ecosystem: 'npm', legacyCase: true }),
  );
}

function assertNamed(expected: string, raw: string | undefined): void {
  if (raw === undefined || (JSON.parse(raw) as unknown) !== expected) {
    throw invalidPackument(expected);
  }
}

/** Track presence without retaining the versions object or confusing it with an empty one. */
async function* inspectVersions(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  state: { present: boolean },
): AsyncGenerator<Uint8Array> {
  const tokenizer = new JsonTokenizer();
  const sink = (token: JsonToken): void => {
    if (token.type !== 'key') return;
    if (token.value === 'versions') state.present = true;
    tokenizer.skipNext();
  };
  for await (const bytes of source) {
    tokenizer.write(bytes, sink);
    yield bytes;
  }
  tokenizer.end(sink);
}

function isUnpublished(timeRaw: string | undefined, versionsPresent: boolean): boolean {
  if (versionsPresent || timeRaw === undefined) return false;
  const time: unknown = JSON.parse(timeRaw);
  return isRecord(time) && isRecord(time.unpublished);
}

async function* candidates(
  name: string,
  members: AsyncIterable<ExtractedMember> | Iterable<ExtractedMember>,
  time: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
  skipped: readonly SkippedMember[] = [],
): AsyncGenerator<VersionCandidate> {
  let seen = 0;
  for await (const member of members) {
    signal?.throwIfAborted();
    if (member.path[0] !== 'versions') continue;
    const ordinal = seen + skipped.length;
    seen += 1;
    const key = member.path[1] as string;
    const manifest: unknown = JSON.parse(member.raw);
    if (!isRecord(manifest) || manifest.version !== key) throw invalidPackument(name);
    const upstreamTime = Object.hasOwn(time, key) ? time[key] : undefined;
    yield {
      ordinal,
      version: key,
      form: 'npm-full',
      ...(upstreamTime === undefined ? {} : { upstreamTime }),
      raw: member.raw,
    };
  }
  if (seen === 0 && skipped.length === 0) throw invalidPackument(name);
}

/** Groups members into writer calls of at most NPM_VERSION_CHUNK versions. */
export async function* versionChunks(
  members: AsyncIterable<VersionCandidate>,
  size = NPM_VERSION_CHUNK,
): AsyncGenerator<VersionCandidate[]> {
  let chunk: VersionCandidate[] = [];
  for await (const member of members) {
    chunk.push(member);
    if (chunk.length >= size) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
}

function found(
  name: string,
  snapshot: SnapshotRef,
  validators: DocumentValidators,
  distTags: Record<string, string> | undefined,
  members: AsyncIterable<VersionCandidate>,
  skipped: readonly SkippedMember[] = [],
): NpmDescribeResult {
  return {
    kind: 'found',
    description: createPackageDescription({
      name,
      snapshot,
      members,
      ...(distTags === undefined ? {} : { distTags }),
      validators,
      documentsComplete: () => skipped.length === 0,
      skippedMembers: () => skipped,
    }),
  };
}

async function* replayCandidates(
  items: readonly VersionCandidate[],
): AsyncGenerator<VersionCandidate> {
  yield* items;
}

async function describeInline(
  name: string,
  bytes: Uint8Array,
  validators: Validators,
  maxBytes: number,
  definitiveAbsence: boolean,
): Promise<NpmDescribeResult> {
  const id =
    strongEtag(validators) ?? `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}`;
  const members: ExtractedMember[] = [];
  const versions = { present: false };
  for await (const member of extractMembers(
    inspectVersions(
      (async function* () {
        yield bytes;
      })(),
      versions,
    ),
    [['name'], ['versions', '*'], ['time'], ['dist-tags']],
    { maxDocumentBytes: maxBytes },
  )) {
    members.push(member);
  }
  assertNamed(name, members.find((m) => m.path[0] === 'name')?.raw);
  const timeRaw = members.find((m) => m.path[0] === 'time')?.raw;
  if (isUnpublished(timeRaw, versions.present)) {
    return { kind: 'not_found', definitive: definitiveAbsence };
  }
  const time = stringRecord(timeRaw) ?? {};
  const distTags = stringRecord(members.find((m) => m.path[0] === 'dist-tags')?.raw, true);
  const accepted: VersionCandidate[] = [];
  for await (const candidate of candidates(name, members, time, undefined))
    accepted.push(candidate);
  return found(
    name,
    snapshotRef(id),
    { 'npm-full': validators },
    distTags,
    replayCandidates(accepted),
  );
}

function resumedValidators(ref: NpmSnapshotRef): Validators {
  const { validators } = ref;
  if (validators === undefined) return {};
  const { etag, lastModified } = validators;
  if (
    (etag !== undefined && typeof etag !== 'string') ||
    (lastModified !== undefined && typeof lastModified !== 'string')
  ) {
    throw new TypeError('snapshot validators must be strings');
  }
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

async function describeStaged(
  deps: NpmPackumentDeps,
  target: NpmPackumentTarget,
  ref: NpmSnapshotRef,
  maxBytes: number,
): Promise<NpmDescribeResult> {
  const { name } = target;
  const validators = resumedValidators(ref);
  const first = await openStagedSnapshot(deps.ctx, deps.store, ref, { codecs: deps.codecs });
  if (first.kind === 'restart') return { kind: 'restart' };
  let nameRaw: string | undefined;
  let timeRaw: string | undefined;
  let distTagsRaw: string | undefined;
  const versionsPresent = { present: false };
  for await (const member of extractMembers(
    inspectVersions(first.body, versionsPresent),
    [['name'], ['time'], ['dist-tags']],
    {
      maxDocumentBytes: maxBytes,
      maxMemberBytes: Math.min(TIME_MEMBER_BYTES, maxBytes),
    },
  )) {
    deps.signal?.throwIfAborted();
    if (member.path[0] === 'name') nameRaw = member.raw;
    else if (member.path[0] === 'time') timeRaw = member.raw;
    else distTagsRaw = member.raw;
  }
  assertNamed(name, nameRaw);
  if (isUnpublished(timeRaw, versionsPresent.present)) {
    return {
      kind: 'not_found',
      definitive:
        (target.sourceType ?? 'npmjs_proxy') === 'npmjs_proxy' &&
        new URL(target.url).origin === 'https://registry.npmjs.org' &&
        target.credential === undefined &&
        ref.definitiveAbsence === true,
    };
  }
  const time = stringRecord(timeRaw) ?? {};
  const distTags = stringRecord(distTagsRaw, true);
  const skipped: SkippedMember[] = [];
  async function* versions(): AsyncGenerator<VersionCandidate> {
    const second = await openStagedSnapshot(deps.ctx, deps.store, ref, { codecs: deps.codecs });
    if (second.kind === 'restart') throw new NpmPackumentError('snapshot_gone');
    yield* candidates(
      name,
      extractMembers(second.body, [['versions', '*']], {
        maxDocumentBytes: maxBytes,
        maxMemberBytes: VERSION_MEMBER_BYTES,
        onOversizedMember: (path) => {
          skipped.push({ version: path[1] as string, reason: 'member_too_large' });
        },
      }),
      time,
      deps.signal,
      skipped,
    );
  }
  return found(name, ref, { 'npm-full': validators }, distTags, versions(), skipped);
}

/**
 * Describes one npm package from its full-form packument. A body over NPM_INLINE_PARSE_BYTES is
 * staged and read in two passes, so no path parses more than one version manifest at a time.
 * A pass that ends in SnapshotCorruptError throws it; everything derived from that pass must be
 * discarded and the session restarted.
 */
export async function describeNpmPackument(
  deps: NpmPackumentDeps,
  target: NpmPackumentTarget,
  options: DescribeOptions,
): Promise<NpmDescribeResult> {
  const maxBytes = target.maxBytes ?? DEFAULT_MAX_BYTES;
  if (options.snapshot?.stagedBlob !== undefined) {
    return describeStaged(deps, target, options.snapshot, maxBytes);
  }
  const known = options.validators?.['npm-full'];
  const request = (conditional: boolean): Promise<UpstreamResponse> =>
    deps.fetch({
      url: target.url,
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(conditional && known?.etag !== undefined ? { 'if-none-match': known.etag } : {}),
        ...(conditional && known?.lastModified !== undefined
          ? { 'if-modified-since': known.lastModified }
          : {}),
      },
      ...(target.credential === undefined ? {} : { credential: target.credential }),
      ...(target.destinations === undefined ? {} : { destinations: target.destinations }),
      purpose: 'metadata',
      maxBytes,
      timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });

  const conditional = known !== undefined;
  const response = await request(conditional);
  const definitiveAbsence =
    (target.sourceType ?? 'npmjs_proxy') === 'npmjs_proxy' &&
    new URL(target.url).origin === 'https://registry.npmjs.org' &&
    target.credential === undefined &&
    response.redirected === false;
  if (response.status === 304) {
    if (!conditional) throw new NpmPackumentError('unexpected_status', 304);
    return { kind: 'not_modified' };
  }
  if (response.status === 404) {
    let body: Uint8Array | null = null;
    if (response.body !== null) {
      const head = await readHead(response.body, NOT_FOUND_BODY_BYTES, deps.onUpstreamBytes);
      if (head.rest === null) body = concat(head.parts, head.size);
      else {
        deps.onUpstreamBytes?.add(head.size);
        await head.rest.cancel().catch(() => undefined);
      }
    }
    let definitive = false;
    if (body !== null && definitiveAbsence) {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        definitive = isRegistryNotFound(target.sourceType ?? 'npmjs_proxy', parsed);
      } catch {
        definitive = false;
      }
    }
    return { kind: 'not_found', definitive };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('http_status', response.status);
  }
  if (response.body === null) throw invalidPackument(target.name);
  const validators = validatorsOf(response);
  const head = await readHead(response.body, NPM_INLINE_PARSE_BYTES, deps.onUpstreamBytes);
  if (head.rest === null) {
    return describeInline(
      target.name,
      concat(head.parts, head.size),
      validators,
      maxBytes,
      definitiveAbsence,
    );
  }

  const firstTag = etagValue(validators.etag);
  const staged: Validators[] = [validators];
  let stagedDefinitiveAbsence = definitiveAbsence;
  const ref = await stageSnapshot(
    deps.ctx,
    async () => {
      const again = await request(false);
      stagedDefinitiveAbsence &&= again.redirected === false;
      if (again.status !== 200 || again.body === null) {
        await again.body?.cancel().catch(() => undefined);
        throw new UpstreamError('http_status', again.status);
      }
      const seen = validatorsOf(again);
      const previous = staged.at(-1);
      if (
        (firstTag !== undefined && etagValue(seen.etag) !== firstTag) ||
        (previous !== undefined && !sameValidators(previous, seen))
      ) {
        await again.body.cancel().catch(() => undefined);
        throw new NpmPackumentError('unstable');
      }
      staged.push(seen);
      return again.body;
    },
    deps.store,
    {
      maxBytes,
      codecs: deps.codecs,
      firstPass: replay(head.parts, head.rest, head.size, deps.onUpstreamBytes),
      ...(deps.onUpstreamBytes === undefined ? {} : { onUpstreamBytes: deps.onUpstreamBytes }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
  );
  if (ref.stagedBlob === undefined) throw new NpmPackumentError('unstable');
  const etag = strongEtag(validators);
  const sameStrong = etag !== undefined && staged.every((seen) => seen.etag === etag);
  const resumable: NpmSnapshotRef = {
    ...(sameStrong ? snapshotRef(etag, ref.stagedBlob) : ref),
    validators: staged[staged.length - 1]!,
    definitiveAbsence: stagedDefinitiveAbsence,
  };
  return describeStaged(deps, target, resumable, maxBytes);
}
