import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { parseSha256, type BlobLifecycle, type BlobStore, type Sha256 } from '../platform/blob.js';
import type { Codecs } from '../platform/codec.js';
import { assertSnapshotRef, snapshotRef, type SnapshotRef } from '../sources/provider.js';
import { twoPassPut, type TwoPassOptions } from './two-pass-put.js';

export class SnapshotCorruptError extends Error {
  override readonly name = 'SnapshotCorruptError';
  constructor() {
    super('staged snapshot bytes do not match their digest');
  }
}

export class SnapshotStagingRejectedError extends Error {
  override readonly name = 'SnapshotStagingRejectedError';
  constructor() {
    super('snapshot staging was rejected');
  }
}

export interface StageSnapshotOptions extends Pick<
  TwoPassOptions,
  'maxBytes' | 'codecs' | 'onUpstreamBytes' | 'signal'
> {
  /** A strong upstream ETag to use as the snapshot id instead of `sha256:<digest>`. */
  readonly id?: string;
}

export interface OpenStagedSnapshotOptions {
  readonly codecs: Pick<Codecs, 'digestTap'>;
}

export type StagedSnapshot =
  | { readonly kind: 'open'; readonly size: number; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: 'restart' };

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function assertStagedRef(ref: SnapshotRef): Sha256 {
  assertSnapshotRef(ref);
  if (ref.stagedBlob === undefined) throw new TypeError('snapshot has no staged blob');
  if (ref.id.startsWith('sha256:') && ref.id !== `sha256:${ref.stagedBlob}`) {
    throw new TypeError('snapshot id does not name the staged blob');
  }
  return parseSha256(ref.stagedBlob);
}

export async function stageSnapshot(
  ctx: OrgContext,
  open: () => Promise<ReadableStream<Uint8Array>>,
  store: BlobStore,
  options: StageSnapshotOptions,
): Promise<SnapshotRef> {
  if (options.id !== undefined) snapshotRef(options.id);
  const result = await twoPassPut(ctx, open, store, {
    maxBytes: options.maxBytes,
    codecs: options.codecs,
    mediaType: 'application/json',
    refetchable: true,
    ...(options.onUpstreamBytes === undefined ? {} : { onUpstreamBytes: options.onUpstreamBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.status !== 'stored') throw new SnapshotStagingRejectedError();
  const digest = parseSha256(hex(result.digests.sha256));
  const ref = snapshotRef(options.id ?? `sha256:${digest}`, digest);
  assertStagedRef(ref);
  return ref;
}

/**
 * `restart` means the staged bytes are gone and the ingest session must start over. The body
 * errors with SnapshotCorruptError at end of input when the bytes do not hash to the staged digest,
 * so a consumer must discard everything it derived from a read that ends in that error.
 */
export async function openStagedSnapshot(
  ctx: OrgContext,
  store: BlobStore,
  ref: SnapshotRef,
  options: OpenStagedSnapshotOptions,
): Promise<StagedSnapshot> {
  const expected = assertStagedRef(ref);
  const found = await store.get(ctx, expected);
  if (found === null) return { kind: 'restart' };
  const tap = options.codecs.digestTap(['sha256'] as const);
  const verify = new TransformStream<Uint8Array, Uint8Array>({
    async flush(controller) {
      const digests = await tap.digests;
      if (hex(digests.sha256) !== expected) controller.error(new SnapshotCorruptError());
    },
  });
  const body = found.body.pipeThrough(tap.transform).pipeThrough(verify);
  return { kind: 'open', size: found.info.size, body };
}

/** Called when the session completes or is abandoned; the blob then follows normal retention. */
export async function releaseStagedSnapshot(
  ctx: OrgContext,
  lifecycle: Pick<BlobLifecycle, 'softDelete'>,
  clock: Clock,
  ref: SnapshotRef,
): Promise<boolean> {
  assertSnapshotRef(ref);
  if (ref.stagedBlob === undefined) return false;
  return lifecycle.softDelete(ctx, parseSha256(ref.stagedBlob), {
    removedAt: clock.now().toISOString(),
  });
}
