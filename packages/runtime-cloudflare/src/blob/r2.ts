import {
  BlobSizeMismatchError,
  BlobValidationError,
  BlobTooLargeError,
  stagedStorageKey,
  stagedListPrefix,
} from '@package-broker/core/platform/blob';
import type { ByteRange, ByteStore } from '@package-broker/core/platform/blob';
import type {
  FixedLengthStream,
  R2Bucket,
  R2GetOptions,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from '@cloudflare/workers-types';

type R2Result<T> = T extends R2ObjectBody
  ? Pick<T, 'size' | 'httpMetadata' | 'range' | 'body'>
  : T extends R2Object
    ? Pick<T, 'size' | 'httpMetadata' | 'range'>
    : T;

export type R2BucketLike = {
  put(
    key: Parameters<R2Bucket['put']>[0],
    value: Parameters<R2Bucket['put']>[1],
    options?: Pick<R2PutOptions, 'sha256' | 'httpMetadata'>,
  ): Promise<R2Result<Awaited<ReturnType<R2Bucket['put']>>>>;
  get(
    key: Parameters<R2Bucket['get']>[0],
    options?: Pick<R2GetOptions, 'range'>,
  ): Promise<R2Result<Awaited<ReturnType<R2Bucket['get']>>>>;
  head(
    ...args: Parameters<R2Bucket['head']>
  ): Promise<R2Result<Awaited<ReturnType<R2Bucket['head']>>>>;
  delete: R2Bucket['delete'];
  createMultipartUpload?: R2Bucket['createMultipartUpload'];
  list?: (options?: { prefix?: string; cursor?: string }) => Promise<{
    objects: readonly { key: string; uploaded?: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
};

export type FixedLengthStreamLike = Pick<FixedLengthStream, 'readable' | 'writable'>;

export interface R2ByteStoreOptions {
  readonly fixedLengthStream?: (size: number) => FixedLengthStreamLike;
}

type R2ObjectLike = Pick<R2Object, 'size' | 'httpMetadata'> &
  Partial<Pick<R2ObjectBody, 'body'>> & {
    readonly range?: Exclude<NonNullable<R2Object['range']>, { suffix: number }>;
  };

// Workers and Node disagree on the done reader result; the core port uses Node's stream type.
type ByteStoreObject = Omit<R2ObjectLike, 'body'> &
  Partial<Pick<NonNullable<Awaited<ReturnType<ByteStore['get']>>>, 'body'>>;

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const BAD_DIGEST = /\(10037\)|SHA-256 checksum you specified did not match/;

function defaultFixedLengthStream(size: number): FixedLengthStreamLike {
  const factory = (
    globalThis as { FixedLengthStream?: new (size: number) => FixedLengthStreamLike }
  ).FixedLengthStream;
  if (factory === undefined) throw new Error('FixedLengthStream is unavailable in this runtime');
  return new factory(size);
}

function asObject(value: unknown): ByteStoreObject | null {
  if (value === null || value === undefined) return null;
  const candidate = value as Partial<R2ObjectLike>;
  if (typeof candidate.size !== 'number') throw new TypeError('unexpected R2 object shape');
  return candidate as unknown as ByteStoreObject;
}

const mediaTypeOf = (object: Pick<R2ObjectLike, 'httpMetadata'>): string =>
  object.httpMetadata?.contentType ?? DEFAULT_MEDIA_TYPE;

function countingStream(
  size: number,
  onMismatch: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  let held: Uint8Array | null = null;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.length === 0) return;
      seen += chunk.length;
      if (seen > size) {
        onMismatch();
        controller.error(new BlobSizeMismatchError());
        return;
      }
      if (held !== null) controller.enqueue(held);
      held = chunk;
    },
    flush(controller) {
      if (seen !== size) {
        onMismatch();
        controller.error(new BlobSizeMismatchError());
        return;
      }
      if (held !== null) controller.enqueue(held);
    },
  });
}

async function drainEmpty(source: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = source.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > 0) {
      await reader.cancel().catch(() => undefined);
      throw new BlobSizeMismatchError();
    }
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

export function createR2ByteStore(
  bucket: R2BucketLike,
  options: R2ByteStoreOptions = {},
): ByteStore {
  const fixedLengthStream = options.fixedLengthStream ?? defaultFixedLengthStream;

  const active = new Map<string, () => Promise<void>>();
  const store: ByteStore = {
    async putStaged(handle, body, maxBytes, mediaType) {
      stagedStorageKey(handle);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        bucket.createMultipartUpload === undefined
      )
        throw new BlobValidationError();
      const reader = body.getReader();
      let upload:
        Awaited<ReturnType<NonNullable<R2BucketLike['createMultipartUpload']>>> | undefined;
      let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
      let digestResult: Promise<ArrayBuffer> | undefined;
      let cancelled = false;
      const abort = async () => {
        cancelled = true;
        await reader.cancel().catch(() => undefined);
        await upload?.abort().catch(() => undefined);
      };
      active.set(handle, abort);
      try {
        upload = await bucket.createMultipartUpload(handle, {
          httpMetadata: { contentType: mediaType },
        });
        if (cancelled) throw new BlobValidationError();
        const factory = (
          crypto as unknown as {
            DigestStream: new (
              name: string,
            ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
          }
        ).DigestStream;
        const digest = new factory('SHA-256');
        digestResult = digest.digest;
        writer = digest.getWriter();
        const parts: { partNumber: number; etag: string }[] = [];
        const capacity = 8 * 1024 * 1024;
        let part: Uint8Array | undefined;
        let used = 0;
        let size = 0;
        const flush = async () => {
          const bytes = part!.subarray(0, used);
          part = undefined;
          const uploaded = await upload!.uploadPart(parts.length + 1, bytes);
          parts.push(uploaded);
          used = 0;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) throw new BlobValidationError();
          if (done) break;
          size += value.length;
          if (size > maxBytes) throw new BlobTooLargeError();
          await writer.write(value);
          for (let offset = 0; offset < value.length;) {
            const n = Math.min(capacity - used, value.length - offset);
            part ??= new Uint8Array(capacity);
            part.set(value.subarray(offset, offset + n), used);
            offset += n;
            used += n;
            if (used === capacity) await flush();
          }
        }
        await writer.close();
        if (used > 0) await flush();
        if (cancelled) throw new BlobValidationError();
        if (size === 0) {
          await upload.abort();
          await bucket.put(handle, new Uint8Array(), { httpMetadata: { contentType: mediaType } });
        } else await upload.complete(parts);
        if (cancelled) throw new BlobValidationError();
        const sha256 = [...new Uint8Array(await digest.digest)]
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('') as import('@package-broker/core/platform/blob').Sha256;
        return { sha256, size };
      } catch (error) {
        await abort();
        await writer?.abort().catch(() => undefined);
        await digestResult?.catch(() => undefined);
        await bucket.delete(handle).catch(() => undefined);
        throw error;
      } finally {
        active.delete(handle);
        reader.releaseLock();
      }
    },
    async openStaged(handle) {
      stagedStorageKey(handle);
      const found = asObject(await bucket.get(handle));
      if (found?.body === undefined) throw new BlobValidationError();
      return found.body;
    },
    async promote(handle, sha256, size, mediaType) {
      const key = stagedStorageKey(handle, sha256);
      let found: ByteStoreObject | null = null;
      try {
        found = asObject(await bucket.get(handle));
        if (found?.body === undefined || found.size !== size) throw new BlobSizeMismatchError();
        await store.putVerified(key, found.body, {
          sha256,
          size,
          mediaType,
        });
        await bucket.delete(handle);
      } catch (error) {
        await found?.body?.cancel().catch(() => undefined);
        await active.get(handle)?.();
        throw error;
      }
    },
    async discardStaged(handle) {
      stagedStorageKey(handle);
      await active.get(handle)?.();
      await bucket.delete(handle);
    },
    async listStaged(olderThan, orgPrefix) {
      const prefix = stagedListPrefix(orgPrefix);
      if (!Number.isFinite(Date.parse(olderThan)) || bucket.list === undefined)
        throw new BlobValidationError();
      const objects: import('@package-broker/core/platform/blob').StagedByteObject[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await bucket.list({
          prefix,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const object of page.objects) {
          if (object.uploaded !== undefined && object.uploaded.getTime() < Date.parse(olderThan)) {
            try {
              stagedStorageKey(object.key as never);
            } catch {
              continue;
            }
            objects.push({ handle: object.key as never, createdAt: object.uploaded.toISOString() });
            if (objects.length === 50) return objects;
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && (cursor === undefined || seen.has(cursor)))
          throw new BlobValidationError();
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      return objects;
    },
    async putVerified(storageKey, source, input) {
      const body = input.size === 0 ? await drainEmpty(source) : source;
      const existing = asObject(await bucket.head(storageKey));
      const mediaType = existing === null ? input.mediaType : mediaTypeOf(existing);
      let mismatch = false;
      const counted = body.pipeThrough(
        countingStream(input.size, () => {
          mismatch = true;
        }),
      );
      const fixed = fixedLengthStream(input.size);
      const abort = new AbortController();
      let failedFirst: 'pipe' | 'put' | null = null;
      const piped = counted.pipeTo(fixed.writable, { signal: abort.signal }).catch((error) => {
        failedFirst ??= 'pipe';
        throw error;
      });
      const stored = bucket
        .put(storageKey, fixed.readable, {
          sha256: input.sha256,
          httpMetadata: { contentType: mediaType },
        })
        .catch((error) => {
          failedFirst ??= 'put';
          abort.abort(error);
          throw error;
        });
      const [pipeResult, putResult] = await Promise.allSettled([piped, stored]);
      if (mismatch) throw new BlobSizeMismatchError();
      if (failedFirst === 'pipe' && pipeResult.status === 'rejected') throw pipeResult.reason;
      if (putResult.status === 'rejected') {
        const reason: unknown = putResult.reason;
        const message = reason instanceof Error ? reason.message : '';
        if (BAD_DIGEST.test(message)) throw new BlobValidationError();
        throw reason;
      }
      if (pipeResult.status === 'rejected') throw pipeResult.reason;
      return { size: input.size, mediaType };
    },

    async get(storageKey, range?: ByteRange) {
      const found = asObject(
        await bucket.get(storageKey, range === undefined ? undefined : { range }),
      );
      if (found === null) return null;
      const stream = found.body;
      if (stream === undefined) throw new TypeError('unexpected R2 object shape');
      let served: ByteRange | null = null;
      if (range !== undefined) {
        const echoed = found.range;
        if (
          echoed === undefined ||
          echoed.offset !== range.offset ||
          echoed.length !== range.length
        ) {
          await stream.cancel().catch(() => undefined);
          throw new BlobSizeMismatchError();
        }
        served = { offset: range.offset, length: range.length };
      }
      return { size: found.size, mediaType: mediaTypeOf(found), range: served, body: stream };
    },

    async head(storageKey) {
      const found = asObject(await bucket.head(storageKey));
      return found === null ? null : { size: found.size, mediaType: mediaTypeOf(found) };
    },

    async remove(storageKey) {
      await bucket.delete(storageKey);
    },
  };
  return Object.freeze(store);
}
