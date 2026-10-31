import type { OrgContext, OrgId } from '../db/port.js';
import type { Observability } from './observability.js';

export type Sha256 = string & { readonly __sha256: true };
export type PurgeGeneration = string & { readonly __purgeGeneration: true };

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface BlobInfo {
  /** Current purge generation; empty only for legacy rows never reserved by put. */
  readonly generation: string;
  readonly sha256: Sha256;
  readonly size: number;
  readonly mediaType: string;
  readonly purgeAfter: string | null;
}

export interface BlobRead {
  readonly info: BlobInfo;
  readonly body: ReadableStream<Uint8Array>;
}

export interface BlobPutInput {
  readonly size: number;
  readonly mediaType: string;
  readonly refetchable: boolean;
}

export type StagedBlobHandle = string & { readonly __stagedBlobHandle: true };

export interface StagedBlob {
  /** Opaque handle bound to the organization and reserve generation. */
  readonly handle: StagedBlobHandle;
  readonly sha256: Sha256;
  readonly size: number;
  readonly mediaType: string;
}

export interface StagedByteObject {
  readonly handle: StagedBlobHandle;
  readonly createdAt: string;
}

/**
 * Staged capabilities are isolate-local: staging and promotion run within one publish request
 * on the same CoreBlobStore instance. They are not resumable across requests or isolates.
 */
export interface CoreBlobStore extends BlobStore {
  stage(
    ctx: OrgContext,
    body: ReadableStream<Uint8Array>,
    input: { readonly maxBytes: number; readonly mediaType: string },
  ): Promise<StagedBlob>;
  openStaged(ctx: OrgContext, staged: StagedBlob): Promise<ReadableStream<Uint8Array>>;
  promote(
    ctx: OrgContext,
    staged: StagedBlob,
    input: { readonly refetchable: false },
  ): Promise<BlobInfo>;
  discard(ctx: OrgContext, staged: StagedBlob): Promise<void>;
}

export interface BlobStore {
  put(
    ctx: OrgContext,
    key: Sha256,
    body: ReadableStream<Uint8Array>,
    input: BlobPutInput,
  ): Promise<BlobInfo>;
  get(ctx: OrgContext, key: Sha256, range?: ByteRange): Promise<BlobRead | null>;
  head(ctx: OrgContext, key: Sha256): Promise<BlobInfo | null>;
}

/**
 * Runtime-only physical store. Contract duties of every implementation:
 * - `putVerified` hashes the whole stream with SHA-256 and counts it, and publishes the final key
 *   only when digest and size both match. It reads the stream to its end before reporting a digest
 *   mismatch, and reports it as BlobValidationError; `createBlobStore` verifies the consumed
 *   bytes and turns a confirmed mismatch into BlobDigestMismatchError. A new bad upload is never
 *   accepted because a good object already exists, and a final object is never replaced with different bytes.
 * - `promote` consumes the staged object on success, including deduplication;
 *   `discardStaged` is idempotent. A failed promotion retains the completed staged object for the sweep.
 * - `get` and `head` report `size` as the total object size, also for a ranged read.
 * - `get` with a range echoes the range actually served in `range` (null for a full read).
 */
export interface ByteStore {
  putStaged(
    handle: StagedBlobHandle,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
    mediaType: string,
  ): Promise<{ readonly sha256: Sha256; readonly size: number }>;
  openStaged(handle: StagedBlobHandle): Promise<ReadableStream<Uint8Array>>;
  promote(handle: StagedBlobHandle, sha256: Sha256, size: number, mediaType: string): Promise<void>;
  discardStaged(handle: StagedBlobHandle): Promise<void>;
  listStaged(olderThan: string, prefix?: string): Promise<readonly StagedByteObject[]>;
  putVerified(
    storageKey: string,
    body: ReadableStream<Uint8Array>,
    input: { sha256: Sha256; size: number; mediaType: string },
  ): Promise<{ size: number; mediaType: string }>;
  get(
    storageKey: string,
    range?: ByteRange,
  ): Promise<{
    size: number;
    mediaType: string;
    range: ByteRange | null;
    body: ReadableStream<Uint8Array>;
  } | null>;
  head(storageKey: string): Promise<{ size: number; mediaType: string } | null>;
  remove(storageKey: string): Promise<void>;
}

/**
 * Metadata for the shared digest row, scoped by organization.
 * - `reserve` runs before the bytes are written. It bumps the purge generation and thereby
 *   invalidates earlier purge claims. While a purge lease is live it refuses with BlobBusyError
 *   instead. It never creates a row visible to `find`: the generation lives on the existing row
 *   or in a separate structure, and an abandoned reservation needs no cleanup.
 * - `publish` is one write: it upserts the row only if `generation` is still current and no purge
 *   lease is live (otherwise it returns null), refuses a size/mediaType conflict with
 *   BlobConflictError, ANDs `refetchable`, and clears `purge_after` and `deleted_at`.
 * - `find` returns null for a row that was never published, has `deleted_at` set, or is under a
 *   live purge lease, so a read may answer 404 while a lease is live.
 * - `inspect` is the lifecycle-aware lookup: it also returns a row under a live purge lease with
 *   `purging: true`, and null for a never-published or deleted row.
 */
export interface BlobMetadataPort {
  reserve(ctx: OrgContext, key: Sha256): Promise<PurgeGeneration>;
  publish(
    ctx: OrgContext,
    input: {
      sha256: Sha256;
      size: number;
      mediaType: string;
      refetchable: boolean;
      generation: PurgeGeneration;
      npmPublishHandle?: StagedBlobHandle;
    },
  ): Promise<BlobInfo | null>;
  find(ctx: OrgContext, key: Sha256): Promise<(BlobInfo & { readonly storageKey?: string }) | null>;
  /**
   * Clears `refetchable` on the live row without touching the purge generation. Returns null
   * unless a live, non-deleted row with this size and media type exists with no live lease and
   * no scheduled purge.
   */
  narrowRefetchable(
    ctx: OrgContext,
    input: { key: Sha256; size: number; mediaType: string },
  ): Promise<BlobInfo | null>;
  inspect(
    ctx: OrgContext,
    key: Sha256,
  ): Promise<{ info: BlobInfo; storageKey?: string; purging: boolean } | null>;
}

/**
 * Runtime-only; never on the plugin ports. Owns scheduling and physical deletion.
 * - `softDelete` sets `purge_after` once, at the first soft delete, to the database time then plus
 *   the organization's `retention_removed_upstream_days`. The caller supplies no retention window.
 *   A later retention change does not move rows already scheduled, and a repeated soft delete
 *   keeps the first deadline. A backdated `removedAt` is accepted; a future one is refused.
 * - `claimPurge` takes an exclusive lease with an expiry. While it is live, `reserve` refuses with
 *   BlobBusyError and `find` hides the row, so no put can publish between the references recheck
 *   and the physical removal. Only `markDeleted`, `cancelPurge` or lease expiry end the lease.
 * - `recheckAndRemove` re-checks references and removes bytes only while the lease and
 *   `generation` are current. The lease duration must exceed the storage delete timeout; the call
 *   refuses to start the delete when the remaining lease is shorter than that timeout, and the
 *   adapter bounds the delete by a deadline, so a lease can never expire mid-delete.
 */
export interface BlobLifecycle {
  softDelete(ctx: OrgContext, key: Sha256, input: { removedAt: string }): Promise<boolean>;
  claimPurge(ctx: OrgContext, key: Sha256): Promise<PurgeGeneration | null>;
  recheckAndRemove(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
  markDeleted(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
  cancelPurge(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
}

export type BlobProbeResult = 'absent' | 'purging' | 'missing-bytes' | 'corrupt' | 'ok';

/** Injected by the runtime: crypto.DigestStream on Workers, node:crypto createHash on Node. */
export interface BlobHasher {
  hashStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array>;
}

export interface BlobProbe {
  probe(ctx: OrgContext, key: Sha256): Promise<BlobProbeResult>;
}

/** Must be created once per process or isolate and shared by every blob store in it. */
export interface BlobUploadAdmission {
  readonly budgetBytes: number;
  tryAcquire(bytes: number): (() => void) | null;
  inFlightBytes(): number;
}

export interface BlobStoreOptions {
  readonly observability?: Observability;
  readonly admission: BlobUploadAdmission;
  readonly maxBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly admissionWaitMs?: number;
}

export const BLOB_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const DEFAULT_UPLOAD_BUDGET_BYTES = 64 * 1024 * 1024;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
const MAX_PUBLISH_ATTEMPTS = 3;
const MAX_ORG_ID_BYTES = 128;
export const BLOB_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-gzip',
  'application/gzip',
  'application/json',
  'text/plain',
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class BlobValidationError extends Error {
  override name = 'BlobValidationError';
  constructor() {
    super('invalid blob input');
  }
}

export class BlobTooLargeError extends BlobValidationError {
  override name = 'BlobTooLargeError';
}

export class BlobRangeError extends Error {
  override name = 'BlobRangeError';
  constructor() {
    super('unsatisfiable range');
  }
}

export class BlobConflictError extends Error {
  override name = 'BlobConflictError';
  constructor() {
    super('blob metadata conflict');
  }
}

export class BlobAdmissionError extends Error {
  override name = 'BlobAdmissionError';
  constructor() {
    super('upload admission refused');
  }
}

export class BlobBusyError extends Error {
  override name = 'BlobBusyError';
  readonly retryable = true;
  constructor() {
    super('blob is being purged');
  }
}

export class BlobBytesVanishedError extends Error {
  override name = 'BlobBytesVanishedError';
  readonly retryable = true;
  constructor() {
    super('blob bytes vanished before publish');
  }
}

export class BlobIdleTimeoutError extends Error {
  override name = 'BlobIdleTimeoutError';
  constructor() {
    super('upload idle deadline exceeded');
  }
}

export class BlobDeadlineError extends Error {
  override name = 'BlobDeadlineError';
  constructor() {
    super('upload total deadline exceeded');
  }
}

export class BlobDigestMismatchError extends Error {
  override name = 'BlobDigestMismatchError';
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super('blob digest mismatch');
    this.expected = expected;
    this.actual = actual;
  }
}

export class BlobSizeMismatchError extends Error {
  override name = 'BlobSizeMismatchError';
  constructor() {
    super('blob size mismatch');
  }
}

export function parseSha256(text: string): Sha256 {
  if (typeof text !== 'string' || !SHA256_PATTERN.test(text)) throw new BlobValidationError();
  return text as Sha256;
}

export function blobStorageKey(orgId: OrgId, key: Sha256): string {
  return `sha256/${orgStorageSegment(orgId)}/${parseSha256(key).slice(0, 2)}/${key}`;
}

export function orgStorageSegment(orgId: OrgId): string {
  if (typeof orgId !== 'string' || orgId === '') throw new BlobValidationError();
  const bytes = new TextEncoder().encode(orgId);
  if (bytes.length === 0 || bytes.length > MAX_ORG_ID_BYTES) throw new BlobValidationError();
  if (new TextDecoder().decode(bytes) !== orgId) throw new BlobValidationError();
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function stagingId(): string {
  let value = BigInt(Date.now());
  for (const byte of crypto.getRandomValues(new Uint8Array(10)))
    value = (value << 8n) | BigInt(byte);
  let id = '';
  for (let index = 0; index < 26; index++) {
    id = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

export function stagedListPrefix(prefix = 'staging/'): string {
  if (prefix !== 'staging/' && !/^staging\/(?:[0-9a-f]{2}){1,128}\/$/.test(prefix))
    throw new BlobValidationError();
  return prefix;
}

export function stagedStorageKey(handle: StagedBlobHandle, sha256?: Sha256): string {
  const match = /^staging\/([0-9a-f]{2,256})\/([0-7][0-9A-HJKMNP-TV-Z]{25})$/.exec(handle);
  if (match === null || match[1]!.length % 2 !== 0) throw new BlobValidationError();
  if (sha256 === undefined) return handle;
  const digest = parseSha256(sha256);
  return `npm-publish/sha256/${match[1]}/${digest.slice(0, 2)}/${digest}/${match[2]}`;
}

export function createBlobUploadAdmission(
  budgetBytes: number = DEFAULT_UPLOAD_BUDGET_BYTES,
): BlobUploadAdmission {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new BlobValidationError();
  let used = 0;
  return {
    budgetBytes,
    tryAcquire(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || used + bytes > budgetBytes) return null;
      used += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        used -= bytes;
      };
    },
    inFlightBytes: () => used,
  };
}

function validateRangeTuple(range: ByteRange): void {
  const { offset, length } = range ?? {};
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    offset + length > Number.MAX_SAFE_INTEGER
  ) {
    throw new BlobRangeError();
  }
}

function resolveRange(range: ByteRange, size: number): ByteRange {
  if (size === 0 || range.offset >= size) throw new BlobRangeError();
  return { offset: range.offset, length: Math.min(range.length, size - range.offset) };
}

interface Bounded {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancel: () => Promise<void>;
  readonly consumed: () => number;
  readonly complete: () => boolean;
  readonly verifiedDigest: () => Promise<string | null>;
}

interface Timeouts {
  readonly idleMs?: number;
  readonly totalMs?: number;
}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  expected: number,
  timeouts: Timeouts = {},
  hash = false,
  allowShort = false,
): Bounded {
  const reader = source.getReader();
  let count = 0;
  let eof = false;
  const bytes = hash ? new Uint8Array(expected) : null;
  let pending: Uint8Array | null = null;
  const cancel = (reason?: unknown): Promise<void> => reader.cancel(reason).catch(() => undefined);
  const startedAt = Date.now();
  const read = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    const remaining =
      timeouts.totalMs === undefined ? Infinity : timeouts.totalMs - (Date.now() - startedAt);
    const idle = timeouts.idleMs ?? Infinity;
    if (remaining === Infinity && idle === Infinity) return reader.read();
    if (remaining <= 0) throw new BlobDeadlineError();
    const deadline = remaining < idle;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(deadline ? new BlobDeadlineError() : new BlobIdleTimeoutError()),
        Math.min(remaining, idle),
      );
    });
    try {
      return await Promise.race([reader.read(), expiry]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          if (pending === null) {
            let result: Awaited<ReturnType<typeof reader.read>>;
            try {
              result = await read();
            } catch (error) {
              void cancel();
              controller.error(error);
              return;
            }
            if (result.done) {
              eof = true;
              if (!allowShort && count !== expected) controller.error(new BlobSizeMismatchError());
              else controller.close();
              return;
            }
            count += result.value.length;
            if (count > expected) {
              await cancel();
              controller.error(allowShort ? new BlobTooLargeError() : new BlobSizeMismatchError());
              return;
            }
            bytes?.set(result.value, count - result.value.length);
            pending = result.value;
          }
          const chunk: Uint8Array = pending;
          let piece = chunk.subarray(0, BLOB_CHUNK_BYTES);
          pending = chunk.length > BLOB_CHUNK_BYTES ? chunk.subarray(BLOB_CHUNK_BYTES) : null;
          if (piece.buffer.byteLength > BLOB_CHUNK_BYTES) piece = piece.slice();
          if (piece.length > 0) {
            if (pending === null && count === expected) {
              for (;;) {
                let tail: Awaited<ReturnType<typeof reader.read>>;
                try {
                  tail = await read();
                } catch (error) {
                  void cancel();
                  controller.error(error);
                  return;
                }
                if (tail.done) {
                  eof = true;
                  break;
                }
                if (tail.value.length > 0) {
                  await cancel();
                  controller.error(
                    allowShort ? new BlobTooLargeError() : new BlobSizeMismatchError(),
                  );
                  return;
                }
              }
              controller.enqueue(piece);
              controller.close();
              return;
            }
            controller.enqueue(piece);
            return;
          }
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    cancel,
    consumed: () => count,
    complete: () => eof,
    verifiedDigest: async () => {
      if (!eof || count !== expected || bytes === null) return null;
      return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    },
  };
}

function validatePutInput(input: BlobPutInput, maxBytes: number): void {
  if (
    input !== null &&
    typeof input === 'object' &&
    Number.isSafeInteger(input.size) &&
    input.size > maxBytes
  ) {
    throw new BlobTooLargeError();
  }
  if (
    input === null ||
    typeof input !== 'object' ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    typeof input.mediaType !== 'string' ||
    !BLOB_MEDIA_TYPES.has(input.mediaType) ||
    typeof input.refetchable !== 'boolean'
  ) {
    throw new BlobValidationError();
  }
}

const STAGING_RETENTION_MS = 24 * 3600 * 1000;
interface StagedCapability {
  readonly orgId: OrgId;
  readonly staged: StagedBlob;
  readonly createdAt: number;
  readonly expiryTimer: ReturnType<typeof setTimeout>;
}
function publicBlobInfo(info: BlobInfo): BlobInfo {
  return {
    generation: info.generation,
    sha256: info.sha256,
    size: info.size,
    mediaType: info.mediaType,
    purgeAfter: info.purgeAfter,
  };
}

export function createBlobStore(
  byteStore: ByteStore,
  metadata: BlobMetadataPort,
  options: BlobStoreOptions,
): CoreBlobStore {
  const admission = options?.admission;
  if (admission === undefined || typeof admission.tryAcquire !== 'function') {
    throw new BlobValidationError();
  }
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new BlobValidationError();
  if (!Number.isSafeInteger(admission.budgetBytes) || admission.budgetBytes < maxBytes) {
    throw new BlobValidationError();
  }
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new BlobValidationError();
  if (!Number.isSafeInteger(totalMs) || totalMs < 1) throw new BlobValidationError();

  const stagedObjects = new Map<string, StagedCapability>();
  const forget = (handle: StagedBlobHandle) => {
    const entry = stagedObjects.get(handle);
    if (entry !== undefined) clearTimeout(entry.expiryTimer);
    stagedObjects.delete(handle);
  };
  const expire = () => {
    const cutoff = Date.now() - STAGING_RETENTION_MS;
    for (const entry of stagedObjects.values()) {
      if (entry.createdAt < cutoff) forget(entry.staged.handle);
    }
  };
  const owned = (ctx: OrgContext, staged: StagedBlob): StagedBlob => {
    expire();
    const entry = stagedObjects.get(staged?.handle);
    if (
      entry === undefined ||
      entry.orgId !== ctx.orgId ||
      entry.staged.sha256 !== staged.sha256 ||
      entry.staged.size !== staged.size ||
      entry.staged.mediaType !== staged.mediaType
    )
      throw new BlobValidationError();
    return entry.staged;
  };
  const waitMs = options.admissionWaitMs ?? 8000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new BlobValidationError();

  const store: CoreBlobStore = {
    async stage(ctx, body, input) {
      expire();
      try {
        validatePutInput(
          { size: input.maxBytes, mediaType: input.mediaType, refetchable: false },
          maxBytes,
        );
        const org = orgStorageSegment(ctx.orgId);
        const handle = `staging/${org}/${stagingId()}` as StagedBlobHandle;
        let release = admission.tryAcquire(input.maxBytes);
        const deadline = Date.now() + waitMs;
        while (release === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
          release = admission.tryAcquire(input.maxBytes);
        }
        if (release === null) throw new BlobAdmissionError();
        let bounded: Bounded | null = null;
        try {
          bounded = boundedStream(body, input.maxBytes, { idleMs, totalMs }, false, true);
          const result = await byteStore.putStaged(
            handle,
            bounded.stream,
            input.maxBytes,
            input.mediaType,
          );
          if (!bounded.complete() || bounded.consumed() !== result.size)
            throw new BlobSizeMismatchError();
          const staged = Object.freeze({
            handle,
            sha256: parseSha256(result.sha256),
            size: result.size,
            mediaType: input.mediaType,
          });
          const expiryTimer = setTimeout(() => forget(handle), STAGING_RETENTION_MS + 1);
          if (typeof expiryTimer === 'object') expiryTimer.unref?.();
          stagedObjects.set(handle, {
            orgId: ctx.orgId,
            staged,
            createdAt: Date.now(),
            expiryTimer,
          });
          return staged;
        } catch (error) {
          await bounded?.cancel();
          await byteStore.discardStaged(handle).catch(() => undefined);
          throw error;
        } finally {
          release();
        }
      } catch (error) {
        await body.cancel().catch(() => undefined);
        throw error;
      }
    },
    async openStaged(ctx, staged) {
      return byteStore.openStaged(owned(ctx, staged).handle);
    },
    async promote(ctx, staged, input) {
      const value = owned(ctx, staged);
      let promoted = false;
      let published = false;
      try {
        if (input.refetchable !== false) throw new BlobValidationError();
        const existing = await metadata.find(ctx, value.sha256);
        if (
          existing !== null &&
          existing.size === value.size &&
          existing.mediaType === value.mediaType &&
          existing.purgeAfter === null &&
          (await store.head(ctx, value.sha256)) !== null
        ) {
          await metadata.reserve(ctx, value.sha256);
          const reserved = await metadata.narrowRefetchable(ctx, {
            key: value.sha256,
            size: value.size,
            mediaType: value.mediaType,
          });
          if (reserved === null || reserved.purgeAfter !== null) throw new BlobBusyError();
          await byteStore.discardStaged(value.handle);
          return publicBlobInfo(reserved);
        }
        let generation = await metadata.reserve(ctx, value.sha256);
        await byteStore.promote(value.handle, value.sha256, value.size, value.mediaType);
        promoted = true;
        for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
          const info = await metadata.publish(ctx, {
            sha256: value.sha256,
            size: value.size,
            mediaType: value.mediaType,
            refetchable: false,
            generation,
            npmPublishHandle: value.handle,
          });
          if (info !== null) {
            published = true;
            if (
              info.sha256 !== value.sha256 ||
              info.size !== value.size ||
              info.mediaType !== value.mediaType ||
              info.purgeAfter !== null
            )
              throw new BlobConflictError();
            await byteStore.discardStaged(value.handle);
            return info;
          }
          const concurrent = await metadata.narrowRefetchable(ctx, {
            key: value.sha256,
            size: value.size,
            mediaType: value.mediaType,
          });
          if (
            concurrent !== null &&
            concurrent.purgeAfter === null &&
            (await store.head(ctx, value.sha256)) !== null
          ) {
            await byteStore.discardStaged(value.handle);
            return concurrent;
          }
          if (attempt + 1 === MAX_PUBLISH_ATTEMPTS) throw new BlobBusyError();
          generation = await metadata.reserve(ctx, value.sha256);
          const present = await byteStore.head(stagedStorageKey(value.handle, value.sha256));
          if (present === null) throw new BlobBytesVanishedError();
          if (present.size !== value.size) throw new BlobSizeMismatchError();
        }
        throw new BlobBusyError();
      } finally {
        if (promoted && !published) {
          try {
            await byteStore.remove(stagedStorageKey(value.handle, value.sha256));
          } catch {
            options.observability?.counter('pb.blob.promotion_cleanup', { outcome: 'error' });
            options.observability?.log({ level: 'warn', event: 'promoted_blob_cleanup_failed' });
          }
        }
        forget(value.handle);
      }
    },
    async discard(ctx, staged) {
      const value = owned(ctx, staged);
      try {
        await byteStore.discardStaged(value.handle);
      } finally {
        forget(value.handle);
      }
    },
    async put(ctx, key, body, input) {
      const digest = parseSha256(key);
      validatePutInput(input, maxBytes);
      const storageKey = blobStorageKey(ctx.orgId, digest);
      const release = admission.tryAcquire(input.size);
      if (release === null) {
        await body.cancel().catch(() => undefined);
        throw new BlobAdmissionError();
      }
      let bounded: Bounded | null = null;
      try {
        let generation = await metadata.reserve(ctx, digest);
        bounded = boundedStream(body, input.size, { idleMs, totalMs }, true);
        let stored: Awaited<ReturnType<ByteStore['putVerified']>>;
        try {
          stored = await byteStore.putVerified(storageKey, bounded.stream, {
            sha256: digest,
            size: input.size,
            mediaType: input.mediaType,
          });
        } catch (error) {
          if (error instanceof BlobValidationError) {
            const actual = await bounded.verifiedDigest();
            if (actual !== null && actual !== digest) {
              throw new BlobDigestMismatchError(digest, actual);
            }
          }
          throw error;
        }
        if (stored.size !== input.size || bounded.consumed() !== input.size) {
          throw new BlobSizeMismatchError();
        }
        if (stored.mediaType !== input.mediaType) throw new BlobConflictError();
        const publish = (): Promise<BlobInfo | null> =>
          metadata.publish(ctx, {
            sha256: digest,
            size: input.size,
            mediaType: input.mediaType,
            refetchable: input.refetchable,
            generation,
          });
        let info = await publish();
        for (let attempt = 1; info === null; attempt += 1) {
          const concurrent = input.refetchable
            ? await metadata.find(ctx, digest)
            : await metadata.narrowRefetchable(ctx, {
                key: digest,
                size: input.size,
                mediaType: input.mediaType,
              });
          if (
            concurrent !== null &&
            concurrent.size === input.size &&
            concurrent.mediaType === input.mediaType &&
            concurrent.purgeAfter === null
          ) {
            const present = await byteStore.head(storageKey);
            if (present !== null && present.size === input.size) {
              info = concurrent;
              break;
            }
          }
          if (attempt >= MAX_PUBLISH_ATTEMPTS) throw new BlobBusyError();
          generation = await metadata.reserve(ctx, digest);
          const present = await byteStore.head(storageKey);
          if (present === null) throw new BlobBytesVanishedError();
          if (present.size !== input.size) throw new BlobSizeMismatchError();
          info = await publish();
        }
        if (
          info.sha256 !== digest ||
          info.size !== input.size ||
          info.mediaType !== input.mediaType ||
          info.purgeAfter !== null
        ) {
          throw new BlobConflictError();
        }
        return publicBlobInfo(info);
      } catch (error) {
        if (bounded === null) await body.cancel().catch(() => undefined);
        else await bounded.cancel();
        throw error;
      } finally {
        release();
      }
    },

    async get(ctx, key, range) {
      const digest = parseSha256(key);
      if (range !== undefined) validateRangeTuple(range);
      const row = await metadata.find(ctx, digest);
      if (row === null) return null;
      const resolved = range === undefined ? undefined : resolveRange(range, row.size);
      const found = await byteStore.get(
        row.storageKey ?? blobStorageKey(ctx.orgId, digest),
        resolved,
      );
      if (found === null) return null;
      const echoed = found.range;
      if (
        found.size !== row.size ||
        (resolved === undefined
          ? echoed !== null
          : echoed === null ||
            echoed.offset !== resolved.offset ||
            echoed.length !== resolved.length)
      ) {
        await found.body.cancel().catch(() => undefined);
        throw new BlobSizeMismatchError();
      }
      const expected = resolved === undefined ? row.size : resolved.length;
      return { info: publicBlobInfo(row), body: boundedStream(found.body, expected).stream };
    },

    async head(ctx, key) {
      const digest = parseSha256(key);
      const row = await metadata.find(ctx, digest);
      if (row === null) return null;
      const found = await byteStore.head(row.storageKey ?? blobStorageKey(ctx.orgId, digest));
      if (found === null) return null;
      if (found.size !== row.size) throw new BlobSizeMismatchError();
      return publicBlobInfo(row);
    },
  };
  return Object.freeze(store);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Verifies the stored bytes against the digest through the injected streaming hasher. */
export function createBlobProbe(
  byteStore: ByteStore,
  metadata: BlobMetadataPort,
  hasher: BlobHasher,
  options: { readonly idleTimeoutMs?: number; readonly totalTimeoutMs?: number } = {},
): BlobProbe {
  const timeouts: Timeouts = {
    idleMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    totalMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  };
  return Object.freeze({
    async probe(ctx, key) {
      const digest = parseSha256(key);
      const row = await metadata.inspect(ctx, digest);
      if (row === null) return 'absent';
      if (row.purging) return 'purging';
      const found = await byteStore.get(row.storageKey ?? blobStorageKey(ctx.orgId, digest));
      if (found === null) return 'missing-bytes';
      if (found.size !== row.info.size) {
        await found.body.cancel().catch(() => undefined);
        return 'corrupt';
      }
      const bounded = boundedStream(found.body, row.info.size, timeouts);
      try {
        return toHex(await hasher.hashStream(bounded.stream)) === digest ? 'ok' : 'corrupt';
      } catch (error) {
        await bounded.cancel();
        if (error instanceof BlobSizeMismatchError) return 'corrupt';
        throw error;
      }
    },
  } satisfies BlobProbe);
}
