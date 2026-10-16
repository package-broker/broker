import { BlobSizeMismatchError, BlobValidationError } from '@package-broker/core/platform/blob';
import type { ByteRange, ByteStore } from '@package-broker/core/platform/blob';

export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream,
    options?: { sha256?: string | ArrayBuffer; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<unknown>;
  head(key: string): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface FixedLengthStreamLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface R2ByteStoreOptions {
  readonly fixedLengthStream?: (size: number) => FixedLengthStreamLike;
}

interface R2ObjectLike {
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly range?: { readonly offset?: number; readonly length?: number };
  readonly body?: ReadableStream<Uint8Array>;
}

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const BAD_DIGEST = /\(10037\)|SHA-256 checksum you specified did not match/;

function defaultFixedLengthStream(size: number): FixedLengthStreamLike {
  const factory = (
    globalThis as { FixedLengthStream?: new (size: number) => FixedLengthStreamLike }
  ).FixedLengthStream;
  if (factory === undefined) throw new Error('FixedLengthStream is unavailable in this runtime');
  return new factory(size);
}

function asObject(value: unknown): R2ObjectLike | null {
  if (value === null || value === undefined) return null;
  const candidate = value as Partial<R2ObjectLike>;
  if (typeof candidate.size !== 'number') throw new TypeError('unexpected R2 object shape');
  return candidate as R2ObjectLike;
}

const mediaTypeOf = (object: R2ObjectLike): string =>
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

  return Object.freeze({
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
  } satisfies ByteStore);
}
