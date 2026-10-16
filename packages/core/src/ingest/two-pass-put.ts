import type { OrgContext } from '../db/port.js';
import {
  BlobAdmissionError,
  BlobBusyError,
  BlobBytesVanishedError,
  BlobConflictError,
  BlobDeadlineError,
  BlobIdleTimeoutError,
  BlobRangeError,
  BlobSizeMismatchError,
  BlobValidationError,
  DEFAULT_MAX_BLOB_BYTES,
  parseSha256,
  type BlobInfo,
  type BlobStore,
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
  readonly maxBytes: number;
  readonly codecs: Pick<Codecs, 'digestTap'>;
  /** Resolves false to stop before pass 2; nothing is stored. */
  readonly verifyFirstPass?: (first: FirstPass) => boolean | Promise<boolean>;
  /** Receives the bytes read from upstream by each pass, e.g. the `pb.upstream.bytes` counter. */
  readonly onUpstreamBytes?: Pick<Counter, 'add'>;
  /** Cancels both passes and stops before the next `open()`. */
  readonly signal?: AbortSignal;
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

function counter(maxBytes: number): {
  transform: TransformStream<Uint8Array, Uint8Array>;
  count: () => number;
} {
  let total = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.length;
      if (total > maxBytes) controller.error(new TwoPassLimitError(maxBytes));
      else controller.enqueue(chunk);
    },
  });
  return { transform, count: () => total };
}

async function firstPass(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  options: TwoPassOptions,
): Promise<FirstPass> {
  const bound = counter(maxBytes);
  const tap = options.codecs.digestTap(['sha1', 'sha256', 'sha512'] as const);
  try {
    await body
      .pipeThrough(bound.transform)
      .pipeThrough(tap.transform)
      .pipeTo(new WritableStream<Uint8Array>(), signalOptions(options.signal));
    const digests = await tap.digests;
    return {
      sha1: digests.sha1,
      sha256: digests.sha256,
      sha512: digests.sha512,
      size: bound.count(),
    };
  } finally {
    options.onUpstreamBytes?.add(bound.count());
  }
}

interface Unstable {
  readonly unstable: true;
  readonly cause: unknown;
}

const BLOB_ERRORS = [
  BlobAdmissionError,
  BlobBusyError,
  BlobBytesVanishedError,
  BlobConflictError,
  BlobDeadlineError,
  BlobIdleTimeoutError,
  BlobRangeError,
  BlobSizeMismatchError,
  BlobValidationError,
];

function isBlobError(error: unknown): boolean {
  return BLOB_ERRORS.some((type) => error instanceof type);
}

async function attempt(
  ctx: OrgContext,
  open: () => Promise<ReadableStream<Uint8Array>>,
  store: BlobStore,
  maxBytes: number,
  options: TwoPassOptions,
): Promise<TwoPassResult | Unstable> {
  options.signal?.throwIfAborted();
  const first = await firstPass(await open(), maxBytes, options);
  if (options.verifyFirstPass !== undefined && !(await options.verifyFirstPass(first))) {
    return { status: 'rejected', digests: first, size: first.size };
  }

  options.signal?.throwIfAborted();
  const body = await open();
  let count = 0;
  const tap = options.codecs.digestTap(['sha256'] as const);
  const second: { digest: Uint8Array | null } = { digest: null };
  tap.digests.then(
    (d) => {
      second.digest = d.sha256;
    },
    () => undefined,
  );
  const reader = body.pipeThrough(tap.transform, signalOptions(options.signal)).getReader();
  const tapped = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const r = await reader.read();
        if (r.done) controller.close();
        else {
          count += r.value.length;
          controller.enqueue(r.value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  try {
    const info = await store.put(ctx, parseSha256(hex(first.sha256)), tapped, {
      size: first.size,
      mediaType: options.mediaType,
      refetchable: options.refetchable,
    });
    return { status: 'stored', info, digests: first, size: first.size };
  } catch (error) {
    if (!tapped.locked) await tapped.cancel().catch(() => undefined);
    if (options.signal?.aborted) throw error;
    const digest = second.digest;
    if (digest !== null) {
      if (hex(digest) !== hex(first.sha256)) return { unstable: true, cause: error };
      throw error;
    }
    if (error instanceof BlobSizeMismatchError) {
      if (count !== first.size) return { unstable: true, cause: error };
      throw error;
    }
    if (!isBlobError(error) && count >= first.size) return { unstable: true, cause: error };
    throw error;
  } finally {
    options.onUpstreamBytes?.add(count);
  }
}

/**
 * `open()` must return a body that carries its own deadline (the policy fetch does); the pass-2
 * stream is only as bounded as the body it is given.
 */
export async function twoPassPut(
  ctx: OrgContext,
  open: () => Promise<ReadableStream<Uint8Array>>,
  store: BlobStore,
  options: TwoPassOptions,
): Promise<TwoPassResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const maxBytes = Math.min(options.maxBytes, DEFAULT_MAX_BLOB_BYTES);
  let cause: unknown;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const result = await attempt(ctx, open, store, maxBytes, options);
    if (!('unstable' in result)) return result;
    cause = result.cause;
  }
  throw new UpstreamUnstableError({ cause });
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
