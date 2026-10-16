import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  BlobSizeMismatchError,
  createBlobStore,
  createBlobUploadAdmission,
  parseSha256,
  type BlobInfo,
  type BlobLifecycle,
  type BlobMetadataPort,
  type BlobPutInput,
  type ByteStore,
  type Sha256,
} from '../platform/blob.js';
import type { Codecs, DigestAlgorithm } from '../platform/codec.js';
import { snapshotRef } from '../sources/provider.js';
import {
  SnapshotCorruptError,
  openStagedSnapshot,
  releaseStagedSnapshot,
  stageSnapshot,
} from './snapshot.js';
import { TwoPassLimitError, UpstreamUnstableError } from './two-pass-put.js';

const ctx = orgContext('01J0ACME000000000000000000');
const enc = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const codecs: Pick<Codecs, 'digestTap'> = {
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
    const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
    let settle!: { resolve(v: never): void; reject(e: unknown): void };
    const digests = new Promise<Record<A, Uint8Array>>((resolve, reject) => {
      settle = { resolve: resolve as (v: never) => void, reject };
    });
    digests.catch(() => undefined);
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const [, h] of hashes) h.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        settle.resolve(
          Object.fromEntries(hashes.map(([alg, h]) => [alg, new Uint8Array(h.digest())])) as never,
        );
      },
      cancel(reason) {
        settle.reject(reason);
      },
    });
    return { transform, digests };
  },
};

function streamOf(bytes: Uint8Array, chunk = 7): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else {
        controller.enqueue(bytes.slice(offset, offset + chunk));
        offset += chunk;
      }
    },
  });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function memoryStore() {
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const rows = new Map<string, BlobInfo>();
  const published: BlobPutInput[] = [];
  const byteStore: ByteStore = {
    async putVerified(key, body, input) {
      const bytes = await drain(body);
      if (bytes.length !== input.size || sha256(bytes) !== input.sha256) throw new Error('verify');
      objects.set(key, { bytes, mediaType: input.mediaType });
      return { size: bytes.length, mediaType: input.mediaType };
    },
    async get(key) {
      const o = objects.get(key);
      if (o === undefined) return null;
      return {
        size: o.bytes.length,
        mediaType: o.mediaType,
        range: null,
        body: streamOf(o.bytes),
      };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.bytes.length, mediaType: o.mediaType } : null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  const metadata: BlobMetadataPort = {
    reserve: async () => '1' as never,
    publish: async (c, i) => {
      published.push({ size: i.size, mediaType: i.mediaType, refetchable: i.refetchable });
      const info = { sha256: i.sha256, size: i.size, mediaType: i.mediaType, purgeAfter: null };
      rows.set(`${c.orgId}:${i.sha256}`, info);
      return info;
    },
    find: async (c, key) => rows.get(`${c.orgId}:${key}`) ?? null,
    narrowRefetchable: async () => null,
    inspect: async () => null,
  };
  const store = createBlobStore(byteStore, metadata, { admission: createBlobUploadAdmission() });
  return { store, objects, rows, published };
}

function fakeLifecycle(): { lifecycle: BlobLifecycle; calls: [Sha256, string][] } {
  const calls: [Sha256, string][] = [];
  const refuse = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    calls,
    lifecycle: {
      async softDelete(_c, key, input) {
        calls.push([key, input.removedAt]);
        return true;
      },
      claimPurge: refuse,
      recheckAndRemove: refuse,
      markDeleted: refuse,
      cancelPurge: refuse,
    },
  };
}

const packument = enc.encode(
  JSON.stringify({
    name: 'left-pad',
    'dist-tags': { latest: '1.3.0' },
    versions: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `1.${i}.0`,
        { name: 'left-pad', version: `1.${i}.0` },
      ]),
    ),
  }),
);
const options = { maxBytes: 1024 * 1024, codecs };
const read = { codecs };

describe('stageSnapshot', () => {
  it('stores the document as refetchable JSON keyed by its SHA-256', async () => {
    const m = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(packument), m.store, options);
    const digest = sha256(packument);
    expect(ref).toEqual({ id: `sha256:${digest}`, stagedBlob: digest });
    expect(m.published).toEqual([
      { size: packument.length, mediaType: 'application/json', refetchable: true },
    ]);
  });

  it('gives every continuation byte-identical input after upstream changes', async () => {
    const m = memoryStore();
    let current = packument;
    const ref = await stageSnapshot(ctx, async () => streamOf(current), m.store, options);
    current = enc.encode('{"name":"left-pad","versions":{}}');
    for (let n = 0; n < 3; n += 1) {
      const opened = await openStagedSnapshot(ctx, m.store, ref, read);
      expect(opened.kind).toBe('open');
      if (opened.kind !== 'open') return;
      expect(opened.size).toBe(packument.length);
      expect(await drain(opened.body)).toEqual(packument);
    }
  });

  it('propagates upstream instability between the two passes', async () => {
    const m = memoryStore();
    let opens = 0;
    const open = async (): Promise<ReadableStream<Uint8Array>> =>
      streamOf(opens++ % 2 === 0 ? packument : enc.encode('{}'));
    await expect(stageSnapshot(ctx, open, m.store, options)).rejects.toThrow(UpstreamUnstableError);
    expect(m.objects.size).toBe(0);
  });

  it('refuses a document over maxBytes', async () => {
    const m = memoryStore();
    await expect(
      stageSnapshot(ctx, async () => streamOf(packument), m.store, { ...options, maxBytes: 64 }),
    ).rejects.toThrow(TwoPassLimitError);
    expect(m.rows.size).toBe(0);
  });
});

describe('openStagedSnapshot', () => {
  const digest = parseSha256(sha256(packument));

  it('reports restart when the staged blob was never stored', async () => {
    const m = memoryStore();
    const ref = snapshotRef(`sha256:${digest}`, digest);
    expect(await openStagedSnapshot(ctx, m.store, ref, read)).toEqual({ kind: 'restart' });
  });

  it('reports restart when the staged bytes are gone', async () => {
    const m = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(packument), m.store, options);
    m.objects.clear();
    expect(await openStagedSnapshot(ctx, m.store, ref, read)).toEqual({ kind: 'restart' });
  });

  it('refuses a reference without a staged blob', async () => {
    const m = memoryStore();
    await expect(
      openStagedSnapshot(ctx, m.store, snapshotRef(`sha256:${digest}`), read),
    ).rejects.toThrow(TypeError);
  });

  it('refuses a malformed reference', async () => {
    const m = memoryStore();
    await expect(
      openStagedSnapshot(ctx, m.store, { id: 'W/"weak"', stagedBlob: digest }, read),
    ).rejects.toThrow(TypeError);
  });

  it('refuses a sha256 id that does not name the staged blob', async () => {
    const m = memoryStore();
    const other = parseSha256(sha256(enc.encode('other')));
    await expect(
      openStagedSnapshot(ctx, m.store, { id: `sha256:${other}`, stagedBlob: digest }, read),
    ).rejects.toThrow(TypeError);
  });

  it('accepts a strong ETag id beside the staged blob', async () => {
    const m = memoryStore();
    await stageSnapshot(ctx, async () => streamOf(packument), m.store, options);
    const opened = await openStagedSnapshot(ctx, m.store, snapshotRef('"v1"', digest), read);
    expect(opened.kind).toBe('open');
    if (opened.kind === 'open') expect(await drain(opened.body)).toEqual(packument);
  });

  it('throws on a size mismatch instead of restarting', async () => {
    const m = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(packument), m.store, options);
    for (const o of m.objects.values()) o.bytes = o.bytes.slice(1);
    await expect(openStagedSnapshot(ctx, m.store, ref, read)).rejects.toThrow(
      BlobSizeMismatchError,
    );
  });

  it('errors the stream when same-size bytes differ from the staged digest', async () => {
    const m = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(packument), m.store, options);
    for (const o of m.objects.values()) {
      const flipped = o.bytes.slice();
      flipped[10] = (flipped[10] ?? 0) ^ 0x01;
      o.bytes = flipped;
    }
    const opened = await openStagedSnapshot(ctx, m.store, ref, read);
    expect(opened.kind).toBe('open');
    if (opened.kind !== 'open') return;
    await expect(drain(opened.body)).rejects.toThrow(SnapshotCorruptError);
  });

  it('reports restart for a blob staged by another organization', async () => {
    const m = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(packument), m.store, options);
    const other = orgContext('01J0OTHER00000000000000000');
    expect(await openStagedSnapshot(other, m.store, ref, read)).toEqual({ kind: 'restart' });
  });
});

describe('stageSnapshot options', () => {
  it('keeps a caller-supplied strong ETag as the snapshot id', async () => {
    const m = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(packument), m.store, {
      ...options,
      id: '"etag-1"',
    });
    expect(ref).toEqual({ id: '"etag-1"', stagedBlob: sha256(packument) });
  });

  it('refuses a weak ETag as the snapshot id', async () => {
    const m = memoryStore();
    await expect(
      stageSnapshot(ctx, async () => streamOf(packument), m.store, { ...options, id: 'W/"x"' }),
    ).rejects.toThrow(TypeError);
  });

  it('passes upstream byte counts through', async () => {
    const m = memoryStore();
    let total = 0;
    await stageSnapshot(ctx, async () => streamOf(packument), m.store, {
      ...options,
      onUpstreamBytes: { add: (n = 1) => void (total += n) },
    });
    expect(total).toBe(packument.length * 2);
  });

  it('passes the abort signal through', async () => {
    const m = memoryStore();
    const controller = new AbortController();
    controller.abort();
    let opens = 0;
    await expect(
      stageSnapshot(ctx, async () => (opens++, streamOf(packument)), m.store, {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(opens).toBe(0);
  });
});

describe('releaseStagedSnapshot', () => {
  const clock = fixedClock('2026-10-16T12:00:00.000Z');

  it('soft-deletes the staged blob at the clock time', async () => {
    const l = fakeLifecycle();
    const digest = parseSha256(sha256(packument));
    const released = await releaseStagedSnapshot(
      ctx,
      l.lifecycle,
      clock,
      snapshotRef(`sha256:${digest}`, digest),
    );
    expect(released).toBe(true);
    expect(l.calls).toEqual([[digest, '2026-10-16T12:00:00.000Z']]);
  });

  it('does nothing for a snapshot that was not staged', async () => {
    const l = fakeLifecycle();
    const released = await releaseStagedSnapshot(ctx, l.lifecycle, clock, snapshotRef('"abc"'));
    expect(released).toBe(false);
    expect(l.calls).toEqual([]);
  });
});
