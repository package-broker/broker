import type { OrgContext } from '../../db/port.js';
import type { BlobStore } from '../../platform/blob.js';
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
  type SnapshotRef,
  type Validators,
  type VersionCandidate,
} from '../../sources/provider.js';
import { extractMembers, type ExtractedMember } from '../json-stream.js';
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

/** Reads at most `limit` bytes; null when the body is longer, after cancelling it. */
async function readUpTo(
  body: ReadableStream<Uint8Array>,
  limit: number,
  counter: StageSnapshotOptions['onUpstreamBytes'],
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    counter?.add(value.byteLength);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function stringRecord(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return {};
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function* candidates(
  members: AsyncIterable<ExtractedMember> | Iterable<ExtractedMember>,
  time: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
): AsyncGenerator<VersionCandidate> {
  let ordinal = -1;
  for await (const member of members) {
    signal?.throwIfAborted();
    if (member.path[0] !== 'versions') continue;
    ordinal += 1;
    const key = member.path[1] as string;
    const manifest: unknown = JSON.parse(member.raw);
    if (!isRecord(manifest) || manifest.version !== key) continue;
    const upstreamTime = Object.hasOwn(time, key) ? time[key] : undefined;
    yield {
      ordinal,
      version: key,
      form: 'npm-full',
      ...(upstreamTime === undefined ? {} : { upstreamTime }),
      raw: member.raw,
    };
  }
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
  distTags: Record<string, string>,
  members: AsyncIterable<VersionCandidate>,
): NpmDescribeResult {
  return {
    kind: 'found',
    description: createPackageDescription({
      name,
      snapshot,
      members,
      distTags,
      validators,
      documentsComplete: true,
    }),
  };
}

async function describeInline(
  name: string,
  bytes: Uint8Array,
  validators: Validators,
  maxBytes: number,
): Promise<NpmDescribeResult> {
  const id =
    strongEtag(validators) ?? `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}`;
  const members: ExtractedMember[] = [];
  for await (const member of extractMembers(
    (async function* () {
      yield bytes;
    })(),
    [['versions', '*'], ['time'], ['dist-tags']],
    { maxDocumentBytes: maxBytes },
  )) {
    members.push(member);
  }
  const time = stringRecord(members.find((m) => m.path[0] === 'time')?.raw);
  const distTags = stringRecord(members.find((m) => m.path[0] === 'dist-tags')?.raw);
  return found(
    name,
    snapshotRef(id),
    { 'npm-full': validators },
    distTags,
    candidates(members, time, undefined),
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
  name: string,
  ref: NpmSnapshotRef,
  maxBytes: number,
): Promise<NpmDescribeResult> {
  const validators = resumedValidators(ref);
  const first = await openStagedSnapshot(deps.ctx, deps.store, ref, { codecs: deps.codecs });
  if (first.kind === 'restart') return { kind: 'restart' };
  let timeRaw: string | undefined;
  let distTagsRaw: string | undefined;
  for await (const member of extractMembers(first.body, [['time'], ['dist-tags']], {
    maxDocumentBytes: maxBytes,
    maxMemberBytes: Math.min(TIME_MEMBER_BYTES, maxBytes),
  })) {
    deps.signal?.throwIfAborted();
    if (member.path[0] === 'time') timeRaw = member.raw;
    else distTagsRaw = member.raw;
  }
  const time = stringRecord(timeRaw);
  const distTags = stringRecord(distTagsRaw);
  async function* versions(): AsyncGenerator<VersionCandidate> {
    const second = await openStagedSnapshot(deps.ctx, deps.store, ref, { codecs: deps.codecs });
    if (second.kind === 'restart') throw new NpmPackumentError('snapshot_gone');
    yield* candidates(
      extractMembers(second.body, [['versions', '*']], {
        maxDocumentBytes: maxBytes,
        maxMemberBytes: VERSION_MEMBER_BYTES,
      }),
      time,
      deps.signal,
    );
  }
  return found(name, ref, { 'npm-full': validators }, distTags, versions());
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
    return describeStaged(deps, target.name, options.snapshot, maxBytes);
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
  if (response.status === 304) {
    if (!conditional) throw new NpmPackumentError('unexpected_status', 304);
    return { kind: 'not_modified' };
  }
  if (response.status === 404) {
    const body =
      response.body === null
        ? null
        : await readUpTo(response.body, NOT_FOUND_BODY_BYTES, deps.onUpstreamBytes);
    let definitive = false;
    if (body !== null) {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        definitive = isRecord(parsed);
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
  if (response.body === null) throw new NpmPackumentError('invalid');
  const validators = validatorsOf(response);
  const inline = await readUpTo(response.body, NPM_INLINE_PARSE_BYTES, deps.onUpstreamBytes);
  if (inline !== null) return describeInline(target.name, inline, validators, maxBytes);

  const firstTag = etagValue(validators.etag);
  const staged: Validators[] = [];
  const ref = await stageSnapshot(
    deps.ctx,
    async () => {
      const again = await request(false);
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
      ...(deps.onUpstreamBytes === undefined ? {} : { onUpstreamBytes: deps.onUpstreamBytes }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
  );
  const [head] = staged;
  if (head === undefined || ref.stagedBlob === undefined) throw new NpmPackumentError('unstable');
  const etag = strongEtag(head);
  const sameStrong = etag !== undefined && staged.every((seen) => seen.etag === etag);
  const resumable: NpmSnapshotRef = {
    ...(sameStrong ? snapshotRef(etag, ref.stagedBlob) : ref),
    validators: staged.at(-1) ?? head,
  };
  return describeStaged(deps, target.name, resumable, maxBytes);
}
