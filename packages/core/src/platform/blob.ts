import type { OrgContext, OrgId } from '../db/port.js';

export type Sha256 = string & { readonly __sha256: true };
export type PurgeGeneration = string & { readonly __purgeGeneration: true };

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface BlobInfo {
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
 *   only when digest and size both match. A new bad upload is never accepted because a good object
 *   already exists, and a final object is never replaced with different bytes.
 * - `get` and `head` report `size` as the total object size, also for a ranged read.
 * - `get` with a range echoes the range actually served in `range` (null for a full read).
 */
export interface ByteStore {
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
    },
  ): Promise<BlobInfo | null>;
  find(ctx: OrgContext, key: Sha256): Promise<BlobInfo | null>;
  inspect(ctx: OrgContext, key: Sha256): Promise<{ info: BlobInfo; purging: boolean } | null>;
}

/**
 * Runtime-only; never on the plugin ports. Owns scheduling and physical deletion.
 * - `softDelete` sets `purge_after` to the observed removal time plus the organization's
 *   `retention_removed_upstream_days` read from the organization row, using database time. The
 *   caller supplies no retention window, and a repeated removal never shortens a deadline.
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
  readonly admission: BlobUploadAdmission;
  readonly maxBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
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
  const digest = parseSha256(key);
  if (typeof orgId !== 'string' || orgId === '') throw new BlobValidationError();
  const bytes = new TextEncoder().encode(orgId);
  if (bytes.length === 0 || bytes.length > MAX_ORG_ID_BYTES) throw new BlobValidationError();
  if (new TextDecoder().decode(bytes) !== orgId) throw new BlobValidationError();
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `sha256/${hex}/${digest.slice(0, 2)}/${digest}`;
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
}

interface Timeouts {
  readonly idleMs?: number;
  readonly totalMs?: number;
}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  expected: number,
  timeouts: Timeouts = {},
): Bounded {
  const reader = source.getReader();
  let count = 0;
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
              if (count !== expected) controller.error(new BlobSizeMismatchError());
              else controller.close();
              return;
            }
            count += result.value.length;
            if (count > expected) {
              await cancel();
              controller.error(new BlobSizeMismatchError());
              return;
            }
            pending = result.value;
          }
          const chunk: Uint8Array = pending;
          let piece = chunk.subarray(0, BLOB_CHUNK_BYTES);
          pending = chunk.length > BLOB_CHUNK_BYTES ? chunk.subarray(BLOB_CHUNK_BYTES) : null;
          if (piece.buffer.byteLength > BLOB_CHUNK_BYTES) piece = piece.slice();
          if (piece.length > 0) {
            controller.enqueue(piece);
            return;
          }
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { stream, cancel, consumed: () => count };
}

function validatePutInput(input: BlobPutInput, maxBytes: number): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    input.size > maxBytes ||
    typeof input.mediaType !== 'string' ||
    !BLOB_MEDIA_TYPES.has(input.mediaType) ||
    typeof input.refetchable !== 'boolean'
  ) {
    throw new BlobValidationError();
  }
}

export function createBlobStore(
  byteStore: ByteStore,
  metadata: BlobMetadataPort,
  options: BlobStoreOptions,
): BlobStore {
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

  return Object.freeze({
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
        bounded = boundedStream(body, input.size, { idleMs, totalMs });
        const stored = await byteStore.putVerified(storageKey, bounded.stream, {
          sha256: digest,
          size: input.size,
          mediaType: input.mediaType,
        });
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
        return info;
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
      const found = await byteStore.get(blobStorageKey(ctx.orgId, digest), resolved);
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
      return { info: row, body: boundedStream(found.body, expected).stream };
    },

    async head(ctx, key) {
      const digest = parseSha256(key);
      const row = await metadata.find(ctx, digest);
      if (row === null) return null;
      const found = await byteStore.head(blobStorageKey(ctx.orgId, digest));
      if (found === null) return null;
      if (found.size !== row.size) throw new BlobSizeMismatchError();
      return row;
    },
  } satisfies BlobStore);
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
      const found = await byteStore.get(blobStorageKey(ctx.orgId, digest));
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
