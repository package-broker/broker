import type { OrgContext } from '../db/port.js';
import {
  BlobDigestMismatchError,
  DEFAULT_MAX_BLOB_BYTES,
  parseSha256,
  type BlobInfo,
  type CoreBlobStore as BlobStore,
} from '../platform/blob.js';
import type { Codecs } from '../platform/codec.js';
import type { Counter } from '../platform/metrics.js';

export class UpstreamUnstableError extends Error {
  override readonly name = 'UpstreamUnstableError';
  constructor(options?: ErrorOptions) {
    super('upstream returned different bytes between passes', options);
  }
}

export class TwoPassLimitError extends Error {
  override readonly name = 'TwoPassLimitError';
  constructor(readonly maxBytes: number) {
    super(`upstream body exceeds ${maxBytes} bytes`);
  }
}

export interface FirstPass {
  readonly sha1: Uint8Array;
  readonly sha256: Uint8Array;
  readonly sha512: Uint8Array;
  readonly size: number;
}

export interface TwoPassOptions {
  readonly mediaType: string;
  readonly refetchable: boolean;
  /** The store's cap; at most DEFAULT_MAX_BLOB_BYTES. */
  readonly maxBytes: number;
  readonly codecs: Pick<Codecs, 'digestTap'>;
  /** Resolves false to stop before pass 2; nothing is stored. */
  readonly verifyFirstPass?: (first: FirstPass) => boolean | Promise<boolean>;
  /**
   * Receives the bytes read from upstream by each pass, e.g. the `pb.upstream.bytes` counter. The
   * caller wires that counter: the ingest packets and the source sync jobs pass it in.
   */
  readonly onUpstreamBytes?: Pick<Counter, 'add'>;
  /** Cancels both passes and stops before the next `open()`. */
  readonly signal?: AbortSignal;
  /**
   * An already open body read as pass 1 of the first attempt instead of calling `open()`; pass 2
   * and any retry still call `open()`. It is cancelled when twoPassPut ends without reading it.
   */
  readonly firstPass?: ReadableStream<Uint8Array>;
}

export type TwoPassResult =
  | {
      readonly status: 'stored';
      readonly info: BlobInfo;
      readonly digests: FirstPass;
      readonly size: number;
    }
  | { readonly status: 'rejected'; readonly digests: FirstPass; readonly size: number };

const MAX_ATTEMPTS = 2;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function firstPass(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  options: TwoPassOptions,
): Promise<FirstPass> {
  const tap = options.codecs.digestTap(['sha1', 'sha256', 'sha512'] as const);
  tap.digests.catch(() => undefined);
  const reader = body.getReader();
  const writer = tap.transform.writable.getWriter();
  let count = 0;
  const draining = tap.transform.readable.pipeTo(
    new WritableStream<Uint8Array>(),
    signalOptions(options.signal),
  );
  const pumping = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.length;
      if (count > maxBytes) throw new TwoPassLimitError(maxBytes);
      await writer.write(next.value);
    }
    await writer.close();
  })();
  try {
    await Promise.all([pumping, draining]);
    const digests = await tap.digests;
    return {
      sha1: digests.sha1,
      sha256: digests.sha256,
      sha512: digests.sha512,
      size: count,
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await writer.abort(error).catch(() => undefined);
    await Promise.allSettled([pumping, draining]);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    options.onUpstreamBytes?.add(count);
  }
}

interface Unstable {
  readonly unstable: true;
  readonly cause: unknown;
}

async function attempt(
  ctx: OrgContext,
  openFirst: () => Promise<ReadableStream<Uint8Array>>,
  open: () => Promise<ReadableStream<Uint8Array>>,
  store: BlobStore,
  maxBytes: number,
  options: TwoPassOptions,
): Promise<TwoPassResult | Unstable> {
  options.signal?.throwIfAborted();
  const first = await firstPass(await openFirst(), maxBytes, options);
  if (options.verifyFirstPass !== undefined && !(await options.verifyFirstPass(first))) {
    return { status: 'rejected', digests: first, size: first.size };
  }

  options.signal?.throwIfAborted();
  const body = await open();
  let count = 0;
  const tap = options.codecs.digestTap(['sha256'] as const);
  tap.digests.catch(() => undefined);
  const reader = body.getReader();
  // Own the upstream reader so cleanup does not wait for cancellation to cross the transform.
  const input = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    },
    { highWaterMark: 0 },
  );
  const tappedReader = input.pipeThrough(tap.transform, signalOptions(options.signal)).getReader();
  const tapped = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const r = await tappedReader.read();
        if (r.done) controller.close();
        else {
          count += r.value.length;
          controller.enqueue(r.value);
        }
      },
      cancel: (reason) => tappedReader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  let failure: unknown;
  try {
    const info = await store.put(ctx, parseSha256(hex(first.sha256)), tapped, {
      size: first.size,
      mediaType: options.mediaType,
      refetchable: options.refetchable,
    });
    return { status: 'stored', info, digests: first, size: first.size };
  } catch (error) {
    failure = error;
    if (options.signal?.aborted) throw error;
    if (error instanceof BlobDigestMismatchError) return { unstable: true, cause: error };
    throw error;
  } finally {
    await reader.cancel(failure).catch(() => undefined);
    await tappedReader.cancel(failure).catch(() => undefined);
    reader.releaseLock();
    tappedReader.releaseLock();
    options.onUpstreamBytes?.add(count);
  }
}

/**
 * `open()` must return a body that carries its own deadline (the policy fetch does), and
 * `firstPass` must carry its own deadline too; each pass is only as bounded as its body.
 */
export async function twoPassPut(
  ctx: OrgContext,
  open: () => Promise<ReadableStream<Uint8Array>>,
  store: BlobStore,
  options: TwoPassOptions,
): Promise<TwoPassResult> {
  const supplied = options.firstPass;
  let suppliedUnused = supplied;
  try {
    const maxBytes = options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > DEFAULT_MAX_BLOB_BYTES) {
      throw new RangeError(`maxBytes must be an integer from 0 to ${DEFAULT_MAX_BLOB_BYTES}`);
    }
    let cause: unknown;
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      const openFirst =
        n === 1 && supplied !== undefined
          ? async () => {
              suppliedUnused = undefined;
              return supplied;
            }
          : open;
      const result = await attempt(ctx, openFirst, open, store, maxBytes, options);
      if (!('unstable' in result)) return result;
      cause = result.cause;
    }
    throw new UpstreamUnstableError({ cause });
  } finally {
    await suppliedUnused?.cancel().catch(() => undefined);
  }
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
