import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type { OrgId } from '../db/port.js';
import {
  BlobAdmissionError,
  BlobBusyError,
  BlobBytesVanishedError,
  BlobDigestMismatchError,
  BlobDeadlineError,
  BlobIdleTimeoutError,
  BlobConflictError,
  BlobRangeError,
  BlobSizeMismatchError,
  BlobTooLargeError,
  BlobValidationError,
  blobStorageKey,
  stagedStorageKey,
  stagedListPrefix,
  orgStorageSegment,
  createBlobProbe,
  createBlobUploadAdmission,
  createBlobStore,
  parseSha256,
  type BlobInfo,
  type BlobHasher,
  type BlobLifecycle,
  type BlobMetadataPort,
  type CoreBlobStore as BlobStore,
  type BlobStoreOptions,
  type PurgeGeneration,
  type ByteRange,
  type ByteStore,
  type Sha256,
} from './blob.js';

const ORG = '01J0ACME000000000000000000';
const ORG_HEX = '30314a3041434d45' + '30'.repeat(18);
const ctx = orgContext(ORG);
const ctxB = orgContext('01J0BETA000000000000000000');
const enc = new TextEncoder();
const sha = (bytes: Uint8Array): Sha256 =>
  parseSha256(createHash('sha256').update(bytes).digest('hex'));

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const next = chunks[i++];
        if (next === undefined) c.close();
        else c.enqueue(next);
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface Fixture {
  readonly byteStore: ByteStore;
  readonly metadata: BlobMetadataPort;
  readonly lifecycle: BlobLifecycle;
  readonly objects: Map<string, { bytes: Uint8Array; mediaType: string }>;
  readonly publishCalls: unknown[];
  rowRefetchable(key: Sha256): boolean | undefined;
  readonly getRanges: (ByteRange | undefined)[];
  fail: { put?: Error; get?: Error; head?: Error; publish?: Error };
  now: number;
  betweenRecheckAndRemove: (() => Promise<void>) | null;
}

interface Row extends BlobInfo {
  refetchable: boolean;
  deletedAt: string | null;
}

const LEASE_MS = 60_000;
const DELETE_TIMEOUT_MS = 5_000;

function opts(extra: Partial<BlobStoreOptions> = {}): BlobStoreOptions {
  return { admission: createBlobUploadAdmission(), ...extra };
}

function fixture(): Fixture {
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const rows = new Map<string, Row>();
  const gens = new Map<string, number>();
  const leases = new Map<string, number>();
  const publishCalls: unknown[] = [];
  const getRanges: (ByteRange | undefined)[] = [];
  const rk = (c: { orgId: string }, key: string): string => `${c.orgId}/${key}`;
  const gen = (k: string): number => gens.get(k) ?? 0;
  const bump = (k: string): PurgeGeneration => {
    gens.set(k, gen(k) + 1);
    return String(gen(k)) as PurgeGeneration;
  };
  const leased = (k: string): boolean => (leases.get(k) ?? 0) > f.now;
  const info = (r: Row): BlobInfo => ({
    generation: r.generation,
    sha256: r.sha256,
    size: r.size,
    mediaType: r.mediaType,
    purgeAfter: r.purgeAfter,
  });
  const f: Fixture = {
    objects,
    publishCalls,
    rowRefetchable: (key) => rows.get(rk(ctx, key))?.refetchable,
    getRanges,
    fail: {},
    now: 1_000,
    betweenRecheckAndRemove: null,
    byteStore: {
      async putStaged() {
        throw new Error('not_implemented');
      },
      async openStaged() {
        throw new Error('not_implemented');
      },
      async promote() {
        throw new Error('not_implemented');
      },
      async discardStaged() {
        throw new Error('not_implemented');
      },
      async listStaged() {
        throw new Error('not_implemented');
      },

      async putVerified(storageKey, body, input) {
        if (f.fail.put) throw f.fail.put;
        const bytes = await drain(body);
        if (bytes.length !== input.size) throw new Error('size');
        if (sha(bytes) !== input.sha256) throw new Error('digest');
        if (!objects.has(storageKey)) {
          objects.set(storageKey, { bytes, mediaType: input.mediaType });
        }
        return { size: bytes.length, mediaType: input.mediaType };
      },
      async get(storageKey, range) {
        if (f.fail.get) throw f.fail.get;
        getRanges.push(range);
        const o = objects.get(storageKey);
        if (!o) return null;
        const bytes = range ? o.bytes.slice(range.offset, range.offset + range.length) : o.bytes;
        return {
          size: o.bytes.length,
          mediaType: o.mediaType,
          range: range ? { offset: range.offset, length: bytes.length } : null,
          body: streamOf([bytes]),
        };
      },
      async head(storageKey) {
        if (f.fail.head) throw f.fail.head;
        const o = objects.get(storageKey);
        return o ? { size: o.bytes.length, mediaType: o.mediaType } : null;
      },
      async remove(storageKey) {
        objects.delete(storageKey);
      },
    },
    metadata: {
      async reserve(c, key) {
        const k = rk(c, key);
        if (leased(k)) throw new BlobBusyError();
        const generation = bump(k);
        const row = rows.get(k);
        if (row !== undefined) rows.set(k, { ...row, generation });
        return generation;
      },
      async publish(c, input) {
        publishCalls.push(input);
        if (f.fail.publish) throw f.fail.publish;
        const k = rk(c, input.sha256);
        if (String(gen(k)) !== input.generation || leased(k)) return null;
        const prev = rows.get(k);
        if (prev && prev.size !== input.size) throw new BlobConflictError();
        if (prev && prev.mediaType !== input.mediaType) throw new BlobConflictError();
        const row: Row = {
          generation: input.generation,
          sha256: input.sha256,
          size: input.size,
          mediaType: input.mediaType,
          purgeAfter: null,
          deletedAt: null,
          refetchable: (prev?.refetchable ?? true) && input.refetchable,
        };
        rows.set(k, row);
        return info(row);
      },
      async narrowRefetchable(c, args) {
        const k = rk(c, args.key);
        const r = rows.get(k);
        if (!r || r.deletedAt !== null || leased(k) || r.purgeAfter !== null) return null;
        if (r.size !== args.size || r.mediaType !== args.mediaType) return null;
        rows.set(k, { ...r, refetchable: false });
        return info(r);
      },
      async inspect(c, key) {
        const k = rk(c, key);
        const r = rows.get(k);
        return r && r.deletedAt === null ? { info: info(r), purging: leased(k) } : null;
      },
      async find(c, key) {
        const k = rk(c, key);
        const r = rows.get(k);
        return r && r.deletedAt === null && !leased(k) ? info(r) : null;
      },
    },
    lifecycle: {
      async softDelete(c, key, input) {
        const r = rows.get(rk(c, key));
        if (!r) return false;
        rows.set(rk(c, key), { ...r, purgeAfter: `${input.removedAt}+365d` });
        return true;
      },
      async claimPurge(c, key) {
        const k = rk(c, key);
        const r = rows.get(k);
        if (!r || r.purgeAfter === null || leased(k)) return null;
        leases.set(k, f.now + LEASE_MS);
        return bump(k);
      },
      async recheckAndRemove(c, key, g) {
        const k = rk(c, key);
        const remaining = (leases.get(k) ?? 0) - f.now;
        if (String(gen(k)) !== g || remaining < DELETE_TIMEOUT_MS) return false;
        await f.betweenRecheckAndRemove?.();
        if ((leases.get(k) ?? 0) - f.now < DELETE_TIMEOUT_MS) return false;
        objects.delete(blobStorageKey(c.orgId, key));
        return true;
      },
      async markDeleted(c, key, g) {
        const k = rk(c, key);
        const r = rows.get(k);
        if (!r || String(gen(k)) !== g) return false;
        rows.set(k, { ...r, deletedAt: 'now' });
        leases.delete(k);
        return true;
      },
      async cancelPurge(c, key, g) {
        const k = rk(c, key);
        const r = rows.get(k);
        if (!r || String(gen(k)) !== g) return false;
        rows.set(k, { ...r, purgeAfter: null });
        leases.delete(k);
        return true;
      },
    },
  };
  return f;
}

const input = { mediaType: 'application/zip', refetchable: true };

describe('parseSha256', () => {
  const good = 'a'.repeat(64);
  it('accepts 64 lowercase hex characters', () => {
    expect(parseSha256(good)).toBe(good);
  });
  it.each([
    ['uppercase', 'A'.repeat(64)],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['empty', ''],
    ['path', `../${'a'.repeat(61)}`],
    ['trailing newline', `${good}\n`],
  ])('rejects %s', (_n, v) => {
    expect(() => parseSha256(v)).toThrow(BlobValidationError);
  });
  it('rejects non-strings', () => {
    expect(() => parseSha256(undefined as unknown as string)).toThrow(BlobValidationError);
  });
});

describe('blobStorageKey', () => {
  const key = parseSha256('ab' + 'c'.repeat(62));
  it('hex-encodes the UTF-8 bytes of a ULID org id', () => {
    expect(blobStorageKey(ctx.orgId, key)).toBe(`sha256/${ORG_HEX}/ab/${key}`);
  });
  it('gives distinct segments to distinct ids, including case variants', () => {
    const seg = (id: string): string => blobStorageKey(orgContext(id).orgId, key).split('/')[1]!;
    const ids = [
      '01J0ACME000000000000000000',
      '01j0acme000000000000000000',
      '01J0ACME000000000000000001',
    ];
    expect(new Set(ids.map(seg)).size).toBe(3);
    for (const id of ids) expect(seg(id)).toMatch(/^[0-9a-f]+$/);
  });
  it('encodes separators and dots so the path cannot traverse', () => {
    const k = blobStorageKey(orgContext('../a/b').orgId, key);
    expect(k).not.toContain('..');
    expect(k.split('/')).toHaveLength(4);
  });
  it.each([
    ['empty', ''],
    ['over 128 bytes', 'a'.repeat(129)],
    ['over 128 bytes in UTF-8', '\u00e9'.repeat(65)],
    ['lone surrogate', '\ud800'],
  ])('rejects %s', (_n, org) => {
    expect(() => blobStorageKey(org as OrgId, key)).toThrow(BlobValidationError);
  });
  it('accepts exactly 128 bytes', () => {
    expect(() => blobStorageKey('a'.repeat(128) as OrgId, key)).not.toThrow();
  });
});

describe('put and read back', () => {
  it('round-trips bytes and head reports exact size and media type', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('hello world');
    const key = sha(bytes);
    const info = await store.put(ctx, key, streamOf([bytes.slice(0, 5), bytes.slice(5)]), {
      size: bytes.length,
      ...input,
    });
    expect(info).toEqual({
      generation: '1',
      sha256: key,
      size: 11,
      mediaType: 'application/zip',
      purgeAfter: null,
    });
    expect(await store.head(ctx, key)).toEqual(info);
    const read = await store.get(ctx, key);
    expect(read?.info).toEqual(info);
    expect(new TextDecoder().decode(await drain(read!.body))).toBe('hello world');
  });

  it('streams reads in chunks of at most 64 KiB', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = new Uint8Array(200 * 1024).fill(7);
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: bytes.length, ...input });
    const read = await store.get(ctx, key);
    const reader = read!.body.getReader();
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      expect(r.value.length).toBeLessThanOrEqual(64 * 1024);
      total += r.value.length;
    }
    expect(total).toBe(bytes.length);
  });

  it('rejects mismatching digest and records no metadata', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const wrong = sha(enc.encode('other'));
    await expect(
      store.put(ctx, wrong, streamOf([enc.encode('hello')]), { size: 5, ...input }),
    ).rejects.toThrow();
    expect(f.publishCalls).toHaveLength(0);
    expect(await store.head(ctx, wrong)).toBeNull();
  });

  it('a pre-existing good object does not make a bad upload succeed', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const good = enc.encode('hello');
    const key = sha(good);
    await store.put(ctx, key, streamOf([good]), { size: 5, ...input });
    f.publishCalls.length = 0;
    await expect(
      store.put(ctx, key, streamOf([enc.encode('HELLO')]), { size: 5, ...input }),
    ).rejects.toThrow();
    expect(f.publishCalls).toHaveLength(0);
  });

  it.each([
    ['short body', 6, 'hello'],
    ['long body', 4, 'hello'],
  ])('rejects %s against declared size', async (_n, size, text) => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode(text);
    await expect(
      store.put(ctx, sha(bytes), streamOf([bytes]), { size, ...input }),
    ).rejects.toThrow();
    expect(f.publishCalls).toHaveLength(0);
  });

  it('rejects when the byte store reports a different size than consumed', async () => {
    const f = fixture();
    const lying: ByteStore = {
      ...f.byteStore,
      async putVerified(k, body, i) {
        await drain(body);
        return { size: i.size + 1, mediaType: i.mediaType };
      },
    };
    const store = createBlobStore(lying, f.metadata, opts());
    const bytes = enc.encode('abc');
    await expect(
      store.put(ctx, sha(bytes), streamOf([bytes]), { size: 3, ...input }),
    ).rejects.toThrow(BlobSizeMismatchError);
    expect(f.publishCalls).toHaveLength(0);
  });

  it.each([
    ['negative size', { size: -1, ...input }],
    ['fractional size', { size: 1.5, ...input }],
    ['unsafe size', { size: Number.MAX_SAFE_INTEGER + 1, ...input }],
    ['NaN size', { size: Number.NaN, ...input }],
    ['over cap', { size: 64 * 1024 * 1024 + 1, ...input }],
    ['media type outside allowlist', { size: 1, mediaType: 'text/html', refetchable: true }],
    [
      'non-boolean refetchable',
      { size: 1, mediaType: 'application/zip', refetchable: 'y' as never },
    ],
  ])('validates %s before any I/O', async (_n, bad) => {
    const f = fixture();
    let touched = false;
    const body = streamOf([enc.encode('x')], () => (touched = true));
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    await expect(store.put(ctx, sha(enc.encode('x')), body, bad)).rejects.toThrow(
      BlobValidationError,
    );
    expect(f.objects.size).toBe(0);
    expect(f.publishCalls).toHaveLength(0);
    expect(touched).toBe(false);
  });

  it('rejects a key that is not a valid digest', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    await expect(
      store.put(ctx, 'nope' as Sha256, streamOf([]), { size: 0, ...input }),
    ).rejects.toThrow(BlobValidationError);
    await expect(store.get(ctx, '../x' as Sha256)).rejects.toThrow(BlobValidationError);
    await expect(store.head(ctx, 'x' as Sha256)).rejects.toThrow(BlobValidationError);
  });

  it('accepts every allowlisted media type', async () => {
    const types = [
      'application/octet-stream',
      'application/zip',
      'application/x-gzip',
      'application/gzip',
      'application/json',
      'text/plain',
    ];
    for (const mediaType of types) {
      const f = fixture();
      const store = createBlobStore(f.byteStore, f.metadata, opts());
      const bytes = enc.encode(mediaType);
      const info = await store.put(ctx, sha(bytes), streamOf([bytes]), {
        size: bytes.length,
        mediaType,
        refetchable: false,
      });
      expect(info.mediaType).toBe(mediaType);
    }
  });

  it('is idempotent for the same digest', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('same');
    const key = sha(bytes);
    const a = await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    const b = await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    expect(b).toEqual({ ...a, generation: '2' });
    expect(b.generation).not.toBe(a.generation);
    expect(f.objects.size).toBe(1);
  });

  it('refuses a conflicting media type for an existing digest', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('same');
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    await expect(
      store.put(ctx, key, streamOf([bytes]), {
        size: 4,
        mediaType: 'text/plain',
        refetchable: true,
      }),
    ).rejects.toThrow(BlobConflictError);
  });

  it('refuses a conflicting size for an existing digest row', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('same');
    const key = sha(bytes);
    const g = await f.metadata.reserve(ctx, key);
    await f.metadata.publish(ctx, {
      sha256: key,
      size: 9,
      mediaType: 'application/zip',
      refetchable: true,
      generation: g,
    });
    await expect(store.put(ctx, key, streamOf([bytes]), { size: 4, ...input })).rejects.toThrow(
      BlobConflictError,
    );
  });

  it('throws when a verified publish still reports a scheduled purge', async () => {
    const f = fixture();
    const stale: BlobMetadataPort = {
      ...f.metadata,
      async publish(c, i) {
        const r = await f.metadata.publish(c, i);
        return r && { ...r, purgeAfter: '2027-01-01T00:00:00.000Z' };
      },
    };
    const bytes = enc.encode('x');
    await expect(
      createBlobStore(f.byteStore, stale, opts()).put(ctx, sha(bytes), streamOf([bytes]), {
        size: 1,
        ...input,
      }),
    ).rejects.toThrow(BlobConflictError);
  });

  it('refuses a stored media type that differs from the request', async () => {
    const f = fixture();
    const other: ByteStore = {
      ...f.byteStore,
      async putVerified(k, body, i) {
        await drain(body);
        return { size: i.size, mediaType: 'text/plain' };
      },
    };
    const bytes = enc.encode('x');
    await expect(
      createBlobStore(other, f.metadata, opts()).put(ctx, sha(bytes), streamOf([bytes]), {
        size: 1,
        ...input,
      }),
    ).rejects.toThrow(BlobConflictError);
    expect(f.publishCalls).toHaveLength(0);
  });

  it('refuses a metadata result that disagrees with the request', async () => {
    const f = fixture();
    const odd: BlobMetadataPort = {
      ...f.metadata,
      async publish(_c, i) {
        return {
          generation: i.generation,
          sha256: i.sha256,
          size: i.size,
          mediaType: 'text/plain',
          purgeAfter: null,
        };
      },
    };
    const store = createBlobStore(f.byteStore, odd, opts());
    const bytes = enc.encode('x');
    await expect(
      store.put(ctx, sha(bytes), streamOf([bytes]), { size: 1, ...input }),
    ).rejects.toThrow(BlobConflictError);
  });

  it('forwards the AND-ed refetchable input to metadata unchanged', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('r');
    await store.put(ctx, sha(bytes), streamOf([bytes]), { size: 1, ...input, refetchable: false });
    expect(f.publishCalls[0]).toMatchObject({ refetchable: false });
  });

  it('propagates cancellation mid-stream to the source', async () => {
    const f = fixture();
    let cancelled = false;
    const aborting: ByteStore = {
      ...f.byteStore,
      async putVerified(_k, body) {
        const reader = body.getReader();
        await reader.read();
        await reader.cancel(new Error('stop'));
        throw new Error('aborted');
      },
    };
    const store = createBlobStore(aborting, f.metadata, opts());
    const chunks = [enc.encode('ab'), enc.encode('cd')];
    await expect(
      store.put(
        ctx,
        sha(enc.encode('abcd')),
        streamOf(chunks, () => (cancelled = true)),
        {
          size: 4,
          ...input,
        },
      ),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(f.publishCalls).toHaveLength(0);
  });
});

describe('failures and missing data', () => {
  it('a storage failure surfaces as an error; a missing object is null', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const key = sha(enc.encode('nothing'));
    expect(await store.get(ctx, key)).toBeNull();
    expect(await store.head(ctx, key)).toBeNull();
    const bytes = enc.encode('data');
    await store.put(ctx, sha(bytes), streamOf([bytes]), { size: 4, ...input });
    f.fail.head = new Error('connection');
    await expect(store.head(ctx, sha(bytes))).rejects.toThrow('connection');
    delete f.fail.head;
    f.fail.get = new Error('connection');
    await expect(store.get(ctx, sha(bytes))).rejects.toThrow('connection');
    f.fail.put = new Error('disk');
    await expect(
      store.put(ctx, sha(enc.encode('n')), streamOf([enc.encode('n')]), { size: 1, ...input }),
    ).rejects.toThrow('disk');
  });

  it('a metadata failure after the physical write leaves no head or get result', async () => {
    const f = fixture();
    f.fail.publish = new Error('db down');
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('orphan');
    const key = sha(bytes);
    await expect(
      store.put(ctx, key, streamOf([bytes]), { size: bytes.length, ...input }),
    ).rejects.toThrow('db down');
    expect(f.objects.size).toBe(1);
    expect(await store.head(ctx, key)).toBeNull();
    expect(await store.get(ctx, key)).toBeNull();
  });

  it('a row whose bytes vanished reads as null and is not deleted', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('gone');
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    f.objects.clear();
    expect(await store.head(ctx, key)).toBeNull();
    expect(await store.get(ctx, key)).toBeNull();
    expect(await f.metadata.find(ctx, key)).not.toBeNull();
  });

  it('a stored size that differs from the row is a typed error', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('size');
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    f.objects.set(blobStorageKey(ctx.orgId, key), {
      bytes: enc.encode('sizes'),
      mediaType: 'application/zip',
    });
    await expect(store.head(ctx, key)).rejects.toThrow(BlobSizeMismatchError);
    await expect(store.get(ctx, key)).rejects.toThrow(BlobSizeMismatchError);
  });
});

describe('ranges', () => {
  async function seeded(text = '0123456789') {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode(text);
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: bytes.length, ...input });
    return { f, store, key };
  }

  it('reads a range and clamps the tail', async () => {
    const { f, store, key } = await seeded();
    const mid = await store.get(ctx, key, { offset: 2, length: 3 });
    expect(new TextDecoder().decode(await drain(mid!.body))).toBe('234');
    const tail = await store.get(ctx, key, { offset: 7, length: 100 });
    expect(new TextDecoder().decode(await drain(tail!.body))).toBe('789');
    expect(f.getRanges.at(-1)).toEqual({ offset: 7, length: 3 });
    expect(tail!.info.size).toBe(10);
  });

  it.each([
    ['offset at size', { offset: 10, length: 1 }],
    ['offset beyond size', { offset: 11, length: 1 }],
    ['zero length', { offset: 0, length: 0 }],
    ['negative length', { offset: 0, length: -1 }],
    ['negative offset', { offset: -1, length: 1 }],
    ['fractional offset', { offset: 0.5, length: 1 }],
    ['fractional length', { offset: 0, length: 1.5 }],
    ['overflowing end', { offset: 1, length: Number.MAX_SAFE_INTEGER }],
    ['unsafe offset', { offset: Number.MAX_SAFE_INTEGER + 1, length: 1 }],
    ['NaN', { offset: Number.NaN, length: 1 }],
    ['Infinity length', { offset: 0, length: Number.POSITIVE_INFINITY }],
  ])('throws BlobRangeError for %s', async (_n, range) => {
    const { store, key } = await seeded();
    await expect(store.get(ctx, key, range)).rejects.toThrow(BlobRangeError);
  });

  it('empty object reads fully and rejects every range', async () => {
    const { store, key } = await seeded('');
    const full = await store.get(ctx, key);
    expect((await drain(full!.body)).length).toBe(0);
    await expect(store.get(ctx, key, { offset: 0, length: 1 })).rejects.toThrow(BlobRangeError);
  });

  it('fails when the byte store answers a range with the full body', async () => {
    const { f, key } = await seeded();
    const full: ByteStore = {
      ...f.byteStore,
      async get(storageKey) {
        const o = f.objects.get(storageKey)!;
        return {
          size: o.bytes.length,
          mediaType: o.mediaType,
          range: null,
          body: streamOf([o.bytes]),
        };
      },
    };
    const strict = createBlobStore(full, f.metadata, opts());
    await expect(strict.get(ctx, key, { offset: 2, length: 3 })).rejects.toThrow(
      BlobSizeMismatchError,
    );
  });

  it('fails when the served range echo differs from the requested range', async () => {
    const { f, key } = await seeded();
    const wrong: ByteStore = {
      ...f.byteStore,
      async get(storageKey) {
        const o = f.objects.get(storageKey)!;
        return {
          size: o.bytes.length,
          mediaType: o.mediaType,
          range: { offset: 0, length: 3 },
          body: streamOf([o.bytes.slice(2, 5)]),
        };
      },
    };
    await expect(
      createBlobStore(wrong, f.metadata, opts()).get(ctx, key, { offset: 2, length: 3 }),
    ).rejects.toThrow(BlobSizeMismatchError);
  });

  it('propagates cancellation of a read to the byte store', async () => {
    const { f, key } = await seeded();
    let cancelled = false;
    const spy: ByteStore = {
      ...f.byteStore,
      async get(storageKey) {
        const o = f.objects.get(storageKey)!;
        return {
          size: o.bytes.length,
          mediaType: o.mediaType,
          range: null,
          body: streamOf([o.bytes.slice(0, 5), o.bytes.slice(5)], () => (cancelled = true)),
        };
      },
    };
    const read = await createBlobStore(spy, f.metadata, opts()).get(ctx, key);
    const reader = read!.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});

describe('lifecycle visibility', () => {
  async function seeded() {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('keep');
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    return { f, store, key, bytes };
  }

  it('a scheduled purge leaves bytes readable', async () => {
    const { f, store, key } = await seeded();
    expect(await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' })).toBe(
      true,
    );
    const read = await store.get(ctx, key);
    expect(read?.info.purgeAfter).not.toBeNull();
    expect(new TextDecoder().decode(await drain(read!.body))).toBe('keep');
  });

  it('a row marked deleted is hidden from get and head', async () => {
    const { f, store, key } = await seeded();
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    const g = (await f.lifecycle.claimPurge(ctx, key))!;
    expect(await f.lifecycle.markDeleted(ctx, key, g)).toBe(true);
    expect(await store.head(ctx, key)).toBeNull();
    expect(await store.get(ctx, key)).toBeNull();
  });

  it('a verified re-upload clears the scheduled purge', async () => {
    const { f, store, key, bytes } = await seeded();
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    const info = await store.put(ctx, key, streamOf([bytes]), { size: 4, ...input });
    expect(info.purgeAfter).toBeNull();
    expect((await store.head(ctx, key))?.purgeAfter).toBeNull();
  });

  it('exposes the read, put and staged-write public port methods', () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts()) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(store).sort()).toEqual([
      'discard',
      'get',
      'head',
      'openStaged',
      'promote',
      'put',
      'stage',
    ]);
  });
});

describe('publish and purge race', () => {
  function gated(f: Fixture) {
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const atGate = new Promise<void>((r) => (reached = r));
    const store: ByteStore = {
      ...f.byteStore,
      async putVerified(k, b, i) {
        reached();
        await gate;
        return f.byteStore.putVerified(k, b, i);
      },
    };
    return { store, open, atGate };
  }

  async function scheduled() {
    const f = fixture();
    const bytes = enc.encode('race');
    const key = sha(bytes);
    await createBlobStore(f.byteStore, f.metadata, opts()).put(ctx, key, streamOf([bytes]), {
      size: 4,
      ...input,
    });
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    return { f, bytes, key };
  }

  const putOnce = (s: BlobStore, key: Sha256, bytes: Uint8Array) =>
    s.put(ctx, key, streamOf([bytes]), { size: 4, ...input });

  it('a live purge lease makes reserve refuse with a retryable error and hides the row', async () => {
    const { f, bytes, key } = await scheduled();
    const token = (await f.lifecycle.claimPurge(ctx, key))!;
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    await expect(putOnce(store, key, bytes)).rejects.toThrow(BlobBusyError);
    expect(await store.head(ctx, key)).toBeNull();
    expect(await f.lifecycle.recheckAndRemove(ctx, key, token)).toBe(true);
    expect(await f.lifecycle.markDeleted(ctx, key, token)).toBe(true);
    const info = await putOnce(store, key, bytes);
    expect(info.purgeAfter).toBeNull();
    expect(f.objects.size).toBe(1);
    expect((await store.get(ctx, key))?.info.size).toBe(4);
  });

  it('a put attempted between recheck and remove is refused, then writes fresh bytes', async () => {
    const { f, bytes, key } = await scheduled();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const token = (await f.lifecycle.claimPurge(ctx, key))!;
    let refused = false;
    f.betweenRecheckAndRemove = async () => {
      await expect(putOnce(store, key, bytes)).rejects.toThrow(BlobBusyError);
      refused = true;
      expect(f.objects.size).toBe(1);
    };
    expect(await f.lifecycle.recheckAndRemove(ctx, key, token)).toBe(true);
    expect(refused).toBe(true);
    expect(f.objects.size).toBe(0);
    expect(await f.lifecycle.markDeleted(ctx, key, token)).toBe(true);
    expect(await store.head(ctx, key)).toBeNull();
    await putOnce(store, key, bytes);
    expect(f.objects.size).toBe(1);
    expect(await store.head(ctx, key)).not.toBeNull();
  });

  it('cancelPurge and lease expiry let reserve succeed again', async () => {
    const { f, bytes, key } = await scheduled();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const token = (await f.lifecycle.claimPurge(ctx, key))!;
    expect(await f.lifecycle.cancelPurge(ctx, key, token)).toBe(true);
    await putOnce(store, key, bytes);
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    await f.lifecycle.claimPurge(ctx, key);
    await expect(putOnce(store, key, bytes)).rejects.toThrow(BlobBusyError);
    f.now += 60_001;
    await putOnce(store, key, bytes);
    expect(await store.head(ctx, key)).not.toBeNull();
  });

  it('a claim made after the reservation fails the put and leaves no live row', async () => {
    const { f, bytes, key } = await scheduled();
    const g = gated(f);
    const pending = putOnce(createBlobStore(g.store, f.metadata, opts()), key, bytes);
    await g.atGate;
    const token = (await f.lifecycle.claimPurge(ctx, key))!;
    g.open();
    await expect(pending).rejects.toThrow(BlobBusyError);
    const plain = createBlobStore(f.byteStore, f.metadata, opts());
    expect(await plain.head(ctx, key)).toBeNull();
    expect(await f.lifecycle.recheckAndRemove(ctx, key, token)).toBe(true);
    expect(await f.lifecycle.markDeleted(ctx, key, token)).toBe(true);
    expect(await plain.get(ctx, key)).toBeNull();
  });

  it('bytes removed before the retry give a distinct retryable error and no live row', async () => {
    const { f, bytes, key } = await scheduled();
    const purging: ByteStore = {
      ...f.byteStore,
      async putVerified(k, b, i) {
        const token = (await f.lifecycle.claimPurge(ctx, key))!;
        const r = await f.byteStore.putVerified(k, b, i);
        expect(await f.lifecycle.recheckAndRemove(ctx, key, token)).toBe(true);
        expect(await f.lifecycle.markDeleted(ctx, key, token)).toBe(true);
        return r;
      },
    };
    const error = await putOnce(createBlobStore(purging, f.metadata, opts()), key, bytes).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BlobBytesVanishedError);
    expect(error).not.toBeInstanceOf(BlobConflictError);
    expect(await createBlobStore(f.byteStore, f.metadata, opts()).get(ctx, key)).toBeNull();
  });

  it('reserve alone never makes a row visible', async () => {
    const f = fixture();
    const key = sha(enc.encode('never'));
    await f.metadata.reserve(ctx, key);
    await f.metadata.reserve(ctx, key);
    expect(await f.metadata.find(ctx, key)).toBeNull();
    expect(await createBlobStore(f.byteStore, f.metadata, opts()).head(ctx, key)).toBeNull();
  });
});

describe('concurrent same-digest puts', () => {
  const delayed = (f: Fixture, calls?: { n: number }): ByteStore => ({
    ...f.byteStore,
    async putVerified(k, b, i) {
      if (calls) calls.n += 1;
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return f.byteStore.putVerified(k, b, i);
    },
  });
  const bytes = enc.encode('concurrent');
  const key = sha(bytes);
  const put = (s: BlobStore) => s.put(ctx, key, streamOf([bytes]), { size: 10, ...input });

  it('succeed with identical info across independent stores', async () => {
    for (let round = 0; round < 50; round += 1) {
      const f = fixture();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => put(createBlobStore(delayed(f), f.metadata, opts()))),
      );
      for (const r of results) expect(r).toEqual(results[0]);
      expect(results[0]).toEqual({
        generation: expect.any(String),
        sha256: key,
        size: 10,
        mediaType: 'application/zip',
        purgeAfter: null,
      });
      expect(f.objects.size).toBe(1);
    }
  });

  it('stale publishes resolve to the row a concurrent writer published', async () => {
    const f = fixture();
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const barred: ByteStore = {
      ...f.byteStore,
      async putVerified(k, b, i) {
        entered += 1;
        if (entered === 8) release();
        await barrier;
        return f.byteStore.putVerified(k, b, i);
      },
      async head(k) {
        await new Promise((r) => setTimeout(r, 1));
        return f.byteStore.head(k);
      },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => put(createBlobStore(barred, f.metadata, opts()))),
    );
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('an overflowing stream never reaches a byte store that commits at exactly size bytes', async () => {
    const f = fixture();
    const first = enc.encode('0123456789');
    const key = sha(first);
    const committing: ByteStore = {
      ...f.byteStore,
      async putVerified(k, b, i) {
        const reader = b.getReader();
        let got = 0;
        while (got < i.size) {
          const r = await reader.read();
          if (r.done) throw new Error('short');
          got += r.value.length;
        }
        f.objects.set(k, { bytes: first, mediaType: i.mediaType });
        const tail = await reader.read();
        if (!tail.done) throw new Error('overflow');
        return { size: got, mediaType: i.mediaType };
      },
    };
    const store = createBlobStore(committing, f.metadata, opts());
    const body = streamOf([first, enc.encode('abcdefghij'), enc.encode('abcdefghijklmnop')]);
    await expect(store.put(ctx, key, body, { size: 10, ...input })).rejects.toThrow(
      BlobSizeMismatchError,
    );
    expect(f.objects.size).toBe(0);
    expect(f.publishCalls).toHaveLength(0);
  });

  it('bad bodies racing a valid upload reject and leave exactly one object', async () => {
    for (const bad of [
      [enc.encode('corruptXXX')],
      [enc.encode('short')],
      [bytes, enc.encode('overflow')],
    ]) {
      const f = fixture();
      const store = createBlobStore(delayed(f), f.metadata, opts());
      const [good, wrong] = await Promise.allSettled([
        put(store),
        store.put(ctx, key, streamOf(bad), { size: 10, ...input }),
      ]);
      expect(good.status).toBe('fulfilled');
      expect(wrong.status).toBe('rejected');
      expect(f.objects.size).toBe(1);
      expect([...f.objects.values()][0]?.bytes).toEqual(bytes);
    }
  });

  const barred = (f: Fixture): ByteStore => {
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    return {
      ...f.byteStore,
      async putVerified(k, b, i) {
        entered += 1;
        if (entered === 8) release();
        await barrier;
        return f.byteStore.putVerified(k, b, i);
      },
      async head(k) {
        await new Promise((r) => setTimeout(r, 1));
        return f.byteStore.head(k);
      },
    };
  };
  const race = (f: Fixture, refetchable: boolean, refuseFirst = 0) => {
    const store = barred(f);
    let refused = 0;
    const metadata: BlobMetadataPort = {
      ...f.metadata,
      async publish(c, i) {
        if (refused < refuseFirst) {
          refused += 1;
          return null;
        }
        return f.metadata.publish(c, i);
      },
    };
    return Promise.all(
      Array.from({ length: 8 }, () =>
        createBlobStore(store, metadata, opts()).put(ctx, key, streamOf([bytes]), {
          size: 10,
          ...input,
          refetchable,
        }),
      ),
    );
  };

  it('barrier puts revive a row with a scheduled purge and clear it', async () => {
    const f = fixture();
    await put(createBlobStore(f.byteStore, f.metadata, opts()));
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    const results = await race(f, true);
    for (const r of results) expect(r.purgeAfter).toBeNull();
    expect((await f.metadata.find(ctx, key))?.purgeAfter).toBeNull();
  });

  it('a stale publish never shortcuts to a row whose purge is still scheduled', async () => {
    const f = fixture();
    await put(createBlobStore(f.byteStore, f.metadata, opts()));
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    expect((await f.metadata.find(ctx, key))?.purgeAfter).not.toBeNull();
    let refused = false;
    const metadata: BlobMetadataPort = {
      ...f.metadata,
      async publish(c, i) {
        if (!refused) {
          refused = true;
          return null;
        }
        return f.metadata.publish(c, i);
      },
    };
    const info = await put(createBlobStore(f.byteStore, metadata, opts()));
    expect(info.purgeAfter).toBeNull();
    expect((await f.metadata.find(ctx, key))?.purgeAfter).toBeNull();
  });

  it('barrier puts with refetchable false narrow an existing refetchable row', async () => {
    const f = fixture();
    await put(createBlobStore(f.byteStore, f.metadata, opts()));
    expect(f.rowRefetchable(key)).toBe(true);
    const results = await race(f, false, 8);
    for (const r of results) expect(r).toEqual(results[0]);
    expect(f.rowRefetchable(key)).toBe(false);
  });

  it('barrier puts on a fresh digest succeed for both refetchable values', async () => {
    for (const refetchable of [true, false]) {
      const f = fixture();
      const results = await race(f, refetchable);
      for (const r of results) expect(r).toEqual(results[0]);
      expect(f.rowRefetchable(key)).toBe(refetchable);
    }
  });

  it('a shortcut row whose bytes vanished falls back to the vanished-bytes error', async () => {
    const f = fixture();
    const store: ByteStore = {
      ...f.byteStore,
      async putVerified(k, b, i) {
        const r = await f.byteStore.putVerified(k, b, i);
        await f.metadata.publish(ctx, {
          sha256: key,
          size: 10,
          ...input,
          generation: await f.metadata.reserve(ctx, key),
        });
        await f.byteStore.remove(k);
        return r;
      },
    };
    const error = await put(createBlobStore(store, f.metadata, opts())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlobBytesVanishedError);
  });

  it('still refuses while a purge lease is live', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    await put(store);
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    await f.lifecycle.claimPurge(ctx, key);
    const results = await Promise.allSettled([
      put(store),
      put(createBlobStore(delayed(f), f.metadata, opts())),
    ]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BlobBusyError);
    }
  });
});

describe('organization isolation', () => {
  it('org B cannot see org A digest and keys differ', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('tenant');
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), { size: 6, ...input });
    expect(await store.head(ctxB, key)).toBeNull();
    expect(await store.get(ctxB, key)).toBeNull();
    expect(blobStorageKey(ctx.orgId, key)).not.toBe(blobStorageKey(ctxB.orgId, key));
    await store.put(ctxB, key, streamOf([bytes]), { size: 6, ...input });
    expect(f.objects.size).toBe(2);
  });
});

describe('upload admission', () => {
  const MIB = 1024 * 1024;
  const big = new Uint8Array(2 * MIB).fill(3);
  const bigKey = sha(big);

  function slowStore(f: Fixture) {
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const atGate = new Promise<void>((r) => (reached = r));
    const store: ByteStore = {
      ...f.byteStore,
      async putVerified(k, b, i) {
        if (i.size < MIB) return f.byteStore.putVerified(k, b, i);
        reached();
        await gate;
        return f.byteStore.putVerified(k, b, i);
      },
    };
    return { store, open, atGate };
  }

  it('refuses uploads that exceed the byte budget before reading them', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission(3 * MIB);
    const slow = slowStore(f);
    const store = createBlobStore(slow.store, f.metadata, { admission, maxBytes: 3 * MIB });
    const first = store.put(ctx, bigKey, streamOf([big]), { size: big.length, ...input });
    await slow.atGate;
    expect(admission.inFlightBytes()).toBe(2 * MIB);
    let pulls = 0;
    let cancelled = false;
    const second = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(big);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(store.put(ctxB, bigKey, second, { size: big.length, ...input })).rejects.toThrow(
      BlobAdmissionError,
    );
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
    const small = enc.encode('s');
    await expect(
      store.put(ctxB, sha(small), streamOf([small]), { size: 1, ...input }),
    ).resolves.toBeDefined();
    slow.open();
    await first;
    expect(admission.inFlightBytes()).toBe(0);
  });

  it('releases the budget after success on the same admission instance', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission(2 * MIB);
    const store = createBlobStore(f.byteStore, f.metadata, { admission, maxBytes: 2 * MIB });
    await store.put(ctx, bigKey, streamOf([big]), { size: big.length, ...input });
    expect(admission.inFlightBytes()).toBe(0);
    await store.put(ctxB, bigKey, streamOf([big]), { size: big.length, ...input });
    expect(admission.inFlightBytes()).toBe(0);
  });

  it('releases the budget after a failed upload', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission(2 * MIB);
    const store = createBlobStore(f.byteStore, f.metadata, { admission, maxBytes: 2 * MIB });
    await expect(
      store.put(ctx, sha(enc.encode('other')), streamOf([big]), { size: big.length, ...input }),
    ).rejects.toThrow();
    expect(admission.inFlightBytes()).toBe(0);
  });

  it('aborts a stalled upload after the idle deadline and releases the budget', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission(2 * MIB);
    const store = createBlobStore(f.byteStore, f.metadata, {
      admission,
      maxBytes: 2 * MIB,
      idleTimeoutMs: 30,
    });
    let cancelled = false;
    let sent = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('ab'));
          return undefined;
        }
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      store.put(ctx, sha(enc.encode('abcd')), stalled, { size: 4, ...input }),
    ).rejects.toThrow(BlobIdleTimeoutError);
    expect(cancelled).toBe(true);
    expect(admission.inFlightBytes()).toBe(0);
    expect(f.publishCalls).toHaveLength(0);
  });

  it('requires an admission from the composition root', () => {
    const f = fixture();
    expect(() => createBlobStore(f.byteStore, f.metadata, {} as BlobStoreOptions)).toThrow(
      BlobValidationError,
    );
  });

  it('clamps maxBytes to the 64 MiB ceiling', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts({ maxBytes: 10 ** 12 }));
    await expect(
      store.put(ctx, bigKey, streamOf([]), { size: 64 * MIB + 1, ...input }),
    ).rejects.toThrow(BlobValidationError);
  });
});

describe('size cap', () => {
  it('refuses a size over maxBytes as BlobTooLargeError before admission or any write', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission();
    const store = createBlobStore(f.byteStore, f.metadata, { admission, maxBytes: 4 });
    const data = enc.encode('12345');
    const error = await store
      .put(ctx, sha(data), streamOf([data]), {
        size: data.length,
        ...input,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(BlobTooLargeError);
    expect(error).toBeInstanceOf(BlobValidationError);
    expect((error as Error).name).toBe('BlobTooLargeError');
    expect(admission.inFlightBytes()).toBe(0);
    expect(f.objects.size).toBe(0);
    expect(f.publishCalls).toHaveLength(0);
    expect(await store.head(ctx, sha(data))).toBeNull();
  });

  it('keeps other invalid input a plain BlobValidationError', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts({ maxBytes: 4 }));
    const data = enc.encode('1234');
    const error = await store
      .put(ctx, sha(data), streamOf([data]), {
        size: data.length,
        mediaType: 'text/html',
        refetchable: true,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(BlobValidationError);
    expect(error).not.toBeInstanceOf(BlobTooLargeError);
  });
});

describe('bounded chunks and range echo', () => {
  it('re-chunks into fresh buffers no larger than 64 KiB', async () => {
    const f = fixture();
    const big = new Uint8Array(300 * 1024).fill(9);
    const key = sha(big);
    await createBlobStore(f.byteStore, f.metadata, opts()).put(ctx, key, streamOf([big]), {
      size: big.length,
      ...input,
    });
    const read = await createBlobStore(f.byteStore, f.metadata, opts()).get(ctx, key);
    const reader = read!.body.getReader();
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      expect(r.value.buffer.byteLength).toBeLessThanOrEqual(64 * 1024);
      total += r.value.length;
    }
    expect(total).toBe(big.length);
  });

  it('copies a small view of a large adapter buffer', async () => {
    const f = fixture();
    const backing = new Uint8Array(512 * 1024).fill(5);
    const view = backing.subarray(100, 110);
    const key = sha(view);
    const seen: number[] = [];
    const spy: ByteStore = {
      ...f.byteStore,
      async putVerified(k, body, i) {
        const reader = body.getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          seen.push(r.value.buffer.byteLength);
        }
        return { size: i.size, mediaType: i.mediaType };
      },
    };
    await createBlobStore(spy, f.metadata, opts()).put(ctx, key, streamOf([view]), {
      size: 10,
      ...input,
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const n of seen) expect(n).toBeLessThanOrEqual(64 * 1024);
  });

  it('rejects a non-null range echo on a full read', async () => {
    const f = fixture();
    const bytes = enc.encode('0123456789');
    const key = sha(bytes);
    await createBlobStore(f.byteStore, f.metadata, opts()).put(ctx, key, streamOf([bytes]), {
      size: 10,
      ...input,
    });
    const odd: ByteStore = {
      ...f.byteStore,
      async get(storageKey) {
        const o = f.objects.get(storageKey)!;
        return {
          size: o.bytes.length,
          mediaType: o.mediaType,
          range: { offset: 0, length: 10 },
          body: streamOf([o.bytes]),
        };
      },
    };
    await expect(createBlobStore(odd, f.metadata, opts()).get(ctx, key)).rejects.toThrow(
      BlobSizeMismatchError,
    );
  });
});

describe('lease timing, deadlines and busy retries', () => {
  it('refuses to start a delete when the remaining lease is shorter than the delete timeout', async () => {
    const f = fixture();
    const bytes = enc.encode('lease');
    const key = sha(bytes);
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    await store.put(ctx, key, streamOf([bytes]), { size: 5, ...input });
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    const token = (await f.lifecycle.claimPurge(ctx, key))!;
    f.now += 56_000;
    expect(await f.lifecycle.recheckAndRemove(ctx, key, token)).toBe(false);
    expect(f.objects.size).toBe(1);
  });

  it('a lease expiring inside the delete window removes nothing and a put sees no half state', async () => {
    const f = fixture();
    const bytes = enc.encode('lease');
    const key = sha(bytes);
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    await store.put(ctx, key, streamOf([bytes]), { size: 5, ...input });
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    const token = (await f.lifecycle.claimPurge(ctx, key))!;
    f.betweenRecheckAndRemove = async () => {
      f.now += 61_000;
      const info = await store.put(ctx, key, streamOf([bytes]), { size: 5, ...input });
      expect(info.purgeAfter).toBeNull();
    };
    expect(await f.lifecycle.recheckAndRemove(ctx, key, token)).toBe(false);
    expect(f.objects.size).toBe(1);
    expect(await store.head(ctx, key)).not.toBeNull();
  });

  it('aborts a trickling upload at the total deadline and releases the budget', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission();
    const store = createBlobStore(f.byteStore, f.metadata, {
      admission,
      idleTimeoutMs: 40,
      totalTimeoutMs: 80,
    });
    let cancelled = false;
    const trickle = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 15));
        c.enqueue(enc.encode('x'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      store.put(ctx, sha(enc.encode('x'.repeat(100))), trickle, { size: 100, ...input }),
    ).rejects.toThrow(BlobDeadlineError);
    expect(cancelled).toBe(true);
    expect(admission.inFlightBytes()).toBe(0);
    expect(f.publishCalls).toHaveLength(0);
  });

  it('throws a retryable BlobBusyError after repeated stale publishes', async () => {
    const f = fixture();
    const stale: BlobMetadataPort = { ...f.metadata, publish: async () => null };
    const bytes = enc.encode('stale');
    const error = await createBlobStore(f.byteStore, stale, opts())
      .put(ctx, sha(bytes), streamOf([bytes]), { size: 5, ...input })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlobBusyError);
    expect((error as BlobBusyError).retryable).toBe(true);
  });

  it('rejects an admission whose budget is below maxBytes', () => {
    const f = fixture();
    expect(() =>
      createBlobStore(f.byteStore, f.metadata, { admission: createBlobUploadAdmission(1024) }),
    ).toThrow(BlobValidationError);
    expect(createBlobUploadAdmission(1024).budgetBytes).toBe(1024);
  });
});

describe('abort paths', () => {
  it('a client abort mid-upload rejects, publishes nothing and stores nothing', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('ab'));
        } else c.error(new Error('client gone'));
      },
    });
    await expect(
      store.put(ctx, sha(enc.encode('abcd')), body, { size: 4, ...input }),
    ).rejects.toThrow('client gone');
    expect(f.publishCalls).toHaveLength(0);
    expect(f.objects.size).toBe(0);
  });

  it('an oversized body cancels the source stream', async () => {
    const f = fixture();
    let cancelled = false;
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('hello');
    await expect(
      store.put(
        ctx,
        sha(bytes),
        streamOf([bytes, bytes], () => (cancelled = true)),
        { size: 4, ...input },
      ),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(f.publishCalls).toHaveLength(0);
  });
});

describe('createBlobProbe', () => {
  const chunkSizes: number[] = [];
  const hasher: BlobHasher = {
    async hashStream(stream) {
      const h = createHash('sha256');
      const reader = stream.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunkSizes.push(r.value.length);
        h.update(r.value);
      }
      return new Uint8Array(h.digest());
    },
  };

  it('distinguishes absent, missing-bytes, corrupt and ok', async () => {
    const f = fixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const probe = createBlobProbe(f.byteStore, f.metadata, hasher);
    const bytes = enc.encode('probe');
    const key = sha(bytes);
    expect(await probe.probe(ctx, key)).toBe('absent');
    await store.put(ctx, key, streamOf([bytes]), { size: 5, ...input });
    expect(await probe.probe(ctx, key)).toBe('ok');
    const sk = blobStorageKey(ctx.orgId, key);
    f.objects.set(sk, { bytes: enc.encode('probes'), mediaType: 'application/zip' });
    expect(await probe.probe(ctx, key)).toBe('corrupt');
    f.objects.set(sk, { bytes: enc.encode('prob3'), mediaType: 'application/zip' });
    expect(await probe.probe(ctx, key)).toBe('corrupt');
    f.objects.clear();
    expect(await probe.probe(ctx, key)).toBe('missing-bytes');
  });

  it('streams in chunks of at most 64 KiB to the injected hasher', async () => {
    const f = fixture();
    const big = new Uint8Array(300 * 1024).fill(4);
    const key = sha(big);
    await createBlobStore(f.byteStore, f.metadata, opts()).put(ctx, key, streamOf([big]), {
      size: big.length,
      ...input,
    });
    chunkSizes.length = 0;
    expect(await createBlobProbe(f.byteStore, f.metadata, hasher).probe(ctx, key)).toBe('ok');
    expect(chunkSizes.length).toBeGreaterThan(4);
    for (const n of chunkSizes) expect(n).toBeLessThanOrEqual(64 * 1024);
  });

  it('reports purging for a row under a live lease', async () => {
    const f = fixture();
    const bytes = enc.encode('purge');
    const key = sha(bytes);
    await createBlobStore(f.byteStore, f.metadata, opts()).put(ctx, key, streamOf([bytes]), {
      size: 5,
      ...input,
    });
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2026-10-16T10:00:00.000Z' });
    await f.lifecycle.claimPurge(ctx, key);
    expect(await createBlobProbe(f.byteStore, f.metadata, hasher).probe(ctx, key)).toBe('purging');
    expect(await createBlobStore(f.byteStore, f.metadata, opts()).get(ctx, key)).toBeNull();
  });

  it('aborts a stalled object read at the idle deadline', async () => {
    const f = fixture();
    const bytes = enc.encode('stall');
    const key = sha(bytes);
    await createBlobStore(f.byteStore, f.metadata, opts()).put(ctx, key, streamOf([bytes]), {
      size: 5,
      ...input,
    });
    const stalled: ByteStore = {
      ...f.byteStore,
      async get() {
        return {
          size: 5,
          mediaType: 'application/zip',
          range: null,
          body: new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }),
        };
      },
    };
    await expect(
      createBlobProbe(stalled, f.metadata, hasher, { idleTimeoutMs: 30 }).probe(ctx, key),
    ).rejects.toThrow(BlobIdleTimeoutError);
  });
});

describe('digest mismatch', () => {
  const stubStore = (fail: (body: ReadableStream<Uint8Array>) => Promise<never>): ByteStore => ({
    async putStaged() {
      throw new Error('not_implemented');
    },
    async openStaged() {
      throw new Error('not_implemented');
    },
    async promote() {
      throw new Error('not_implemented');
    },
    async discardStaged() {
      throw new Error('not_implemented');
    },
    async listStaged() {
      throw new Error('not_implemented');
    },

    putVerified: (_k, body) => fail(body),
    get: async () => null,
    head: async () => null,
    remove: async () => undefined,
  });
  const metadata = fixture().metadata;

  it('throws the typed error when the adapter rejects a fully read body', async () => {
    const bytes = enc.encode('hello');
    const key = sha(enc.encode('other'));
    const byteStore = stubStore(async (body) => {
      await drain(body);
      throw new BlobValidationError();
    });
    const store = createBlobStore(byteStore, metadata, opts());
    const error = await store
      .put(ctx, key, streamOf([bytes]), { size: bytes.length, ...input })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlobDigestMismatchError);
    expect((error as BlobDigestMismatchError).expected).toBe(key);
    expect((error as Error).message).not.toContain('hello');
    expect(JSON.stringify(error)).not.toContain('hello');
  });

  it('keeps a generic adapter failure after the last byte as it is', async () => {
    const failure = new Error('disk');
    const bytes = enc.encode('hello');
    const store = createBlobStore(
      stubStore(async (body) => {
        await drain(body);
        throw failure;
      }),
      metadata,
      opts(),
    );
    await expect(
      store.put(ctx, sha(bytes), streamOf([bytes]), { size: bytes.length, ...input }),
    ).rejects.toBe(failure);
  });

  it('keeps a validation failure before the body was read to the end as it is', async () => {
    const bytes = enc.encode('hello');
    const store = createBlobStore(
      stubStore(async () => {
        throw new BlobValidationError();
      }),
      metadata,
      opts(),
    );
    await expect(
      store.put(ctx, sha(bytes), streamOf([bytes]), { size: bytes.length, ...input }),
    ).rejects.toBeInstanceOf(BlobValidationError);
  });

  it('reports the verified actual digest', async () => {
    const bytes = enc.encode('hello');
    const key = sha(enc.encode('other'));
    const store = createBlobStore(
      stubStore(async (body) => {
        await drain(body);
        throw new BlobValidationError();
      }),
      metadata,
      opts(),
    );
    await expect(
      store.put(ctx, key, streamOf([bytes]), { size: bytes.length, ...input }),
    ).rejects.toMatchObject({ expected: key, actual: sha(bytes) });
  });

  it.each([true, false])(
    'preserves an upstream validation error after the declared bytes (matching=%s)',
    async (matching) => {
      const bytes = enc.encode('hello');
      const failure = new BlobValidationError();
      let sent = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(bytes);
            } else controller.error(failure);
          },
        },
        { highWaterMark: 0 },
      );
      const store = createBlobStore(
        stubStore(async (stream) => {
          await drain(stream);
          throw new Error('unreachable');
        }),
        metadata,
        opts(),
      );
      await expect(
        store.put(ctx, matching ? sha(bytes) : sha(enc.encode('other')), body, {
          size: bytes.length,
          ...input,
        }),
      ).rejects.toBe(failure);
    },
  );

  it('preserves a validation error after clean EOF with matching bytes', async () => {
    const bytes = enc.encode('hello');
    const failure = new BlobValidationError();
    const store = createBlobStore(
      stubStore(async (body) => {
        await drain(body);
        throw failure;
      }),
      metadata,
      opts(),
    );
    await expect(
      store.put(ctx, sha(bytes), streamOf([bytes]), { size: bytes.length, ...input }),
    ).rejects.toBe(failure);
  });

  it('loads blob.ts with strip-only TypeScript support', () => {
    expect(() =>
      stripTypeScriptTypes(readFileSync(new URL('./blob.ts', import.meta.url), 'utf8')),
    ).not.toThrow();
  });

  it('carries only hex digests in its fields', () => {
    const error = new BlobDigestMismatchError('a'.repeat(64), 'b'.repeat(64));
    expect(error.name).toBe('BlobDigestMismatchError');
    expect(Object.keys(error).sort()).toEqual(['actual', 'expected', 'name']);
    expect(error.message).toBe('blob digest mismatch');
  });
});

describe('staged blob ownership', () => {
  it('stages without publishing and refuses another organization before opening bytes', async () => {
    const f = fixture();
    const stagedBytes = new Map<string, Uint8Array>();
    f.byteStore.putStaged = async (handle, body) => {
      const bytes = await drain(body);
      stagedBytes.set(handle, bytes);
      return { sha256: sha(bytes), size: bytes.length };
    };
    f.byteStore.openStaged = async (handle) => streamOf([stagedBytes.get(handle)!]);
    f.byteStore.discardStaged = async (handle) => {
      stagedBytes.delete(handle);
    };
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const staged = await store.stage(ctx, streamOf([enc.encode('staged')]), {
      maxBytes: 50_000_000,
      mediaType: 'application/gzip',
    });
    expect(f.publishCalls).toHaveLength(0);
    expect(await store.head(ctx, staged.sha256)).toBeNull();
    await expect(store.openStaged(ctxB, staged)).rejects.toBeInstanceOf(BlobValidationError);
    await expect(store.discard(ctxB, staged)).rejects.toBeInstanceOf(BlobValidationError);
    await expect(store.promote(ctxB, staged, { refetchable: false })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
    expect(await drain(await store.openStaged(ctx, staged))).toEqual(enc.encode('staged'));
    await store.discard(ctx, staged);
    expect(stagedBytes.size).toBe(0);
    await expect(store.openStaged(ctx, staged)).rejects.toBeInstanceOf(BlobValidationError);
  });

  it('reserves the full cap before consuming bytes and releases admission after failure', async () => {
    const f = fixture();
    const admission = createBlobUploadAdmission();
    const store = createBlobStore(f.byteStore, f.metadata, opts({ admission, admissionWaitMs: 1 }));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.byteStore.putStaged = async () => {
      await pending;
      throw new BlobTooLargeError();
    };
    f.byteStore.discardStaged = async () => {};
    const first = store.stage(ctx, streamOf([]), {
      maxBytes: 50_000_000,
      mediaType: 'application/gzip',
    });
    expect(admission.inFlightBytes()).toBe(50_000_000);
    await expect(
      store.stage(ctx, streamOf([]), { maxBytes: 50_000_000, mediaType: 'application/gzip' }),
    ).rejects.toBeInstanceOf(BlobAdmissionError);
    finish();
    await expect(first).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(admission.inFlightBytes()).toBe(0);
  });
});

function stagingFixture() {
  const f = fixture();
  f.byteStore.putStaged = async (handle, body, maxBytes, mediaType) => {
    const bytes = await drain(body);
    if (bytes.length > maxBytes) throw new BlobTooLargeError();
    f.objects.set(handle, { bytes, mediaType });
    return { sha256: sha(bytes), size: bytes.length };
  };
  f.byteStore.openStaged = async (handle) => streamOf([f.objects.get(handle)!.bytes]);
  f.byteStore.discardStaged = async (handle) => {
    f.objects.delete(handle);
  };
  f.byteStore.promote = async (handle, key, size, mediaType) => {
    await f.byteStore.putVerified(
      stagedStorageKey(handle, key),
      await f.byteStore.openStaged(handle),
      { sha256: key, size, mediaType },
    );
  };
  return f;
}

it('does not promote staged bytes under a purge lease', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await store.stage(ctx, streamOf([enc.encode('lease')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  f.metadata.reserve = async () => {
    throw new BlobBusyError();
  };
  await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
    BlobBusyError,
  );
  expect(f.objects.has(stagedStorageKey(staged.handle, staged.sha256))).toBe(false);
  expect(f.publishCalls).toHaveLength(0);
});
it('refuses a stale staged promotion when its physical bytes vanished before retry', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await store.stage(ctx, streamOf([enc.encode('race')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  const publish = f.metadata.publish;
  let attempts = 0;
  f.metadata.publish = async (...args) => {
    if (++attempts === 1) {
      f.objects.delete(stagedStorageKey(staged.handle, staged.sha256));
      return null;
    }
    return publish(...args);
  };
  await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
    BlobBytesVanishedError,
  );
});
it('refuses a staged upload that the byte adapter did not consume to EOF', async () => {
  const f = stagingFixture();
  f.byteStore.putStaged = async () => ({ sha256: sha(new Uint8Array()), size: 0 });
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  await expect(
    store.stage(ctx, streamOf([enc.encode('pending')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    }),
  ).rejects.toBeInstanceOf(BlobSizeMismatchError);
});
it('bounds staged input by the cap and an idle deadline without publishing metadata', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts({ idleTimeoutMs: 5 }));
  await expect(
    store.stage(ctx, streamOf([enc.encode('too long')]), {
      maxBytes: 2,
      mediaType: 'application/gzip',
    }),
  ).rejects.toBeInstanceOf(BlobTooLargeError);
  await expect(
    store.stage(ctx, new ReadableStream<Uint8Array>(), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    }),
  ).rejects.toBeInstanceOf(BlobIdleTimeoutError);
  expect(f.publishCalls).toHaveLength(0);
});

it('caps stale staged publication retries at three attempts', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await store.stage(ctx, streamOf([enc.encode('retry')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  let attempts = 0;
  f.metadata.publish = async () => {
    attempts++;
    return null;
  };
  await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
    BlobBusyError,
  );
  expect(attempts).toBe(3);
});
it('refuses conflicting metadata returned by staged publication', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await store.stage(ctx, streamOf([enc.encode('identity')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  f.metadata.publish = async () => ({
    generation: 'g',
    sha256: parseSha256('a'.repeat(64)),
    size: staged.size,
    mediaType: staged.mediaType,
    purgeAfter: null,
  });
  await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
    BlobConflictError,
  );
});
it('refuses invalid staged handles and listing prefixes before touching a byte adapter', () => {
  expect(() => stagedStorageKey('staging/61/../../escape' as never)).toThrow(BlobValidationError);
  expect(() => stagedListPrefix('staging/61/../')).toThrow(BlobValidationError);
});

it('admits a staged upload after capacity is released during the wait budget', async () => {
  vi.useFakeTimers();
  try {
    const f = stagingFixture();
    const admission = createBlobUploadAdmission();
    const release = admission.tryAcquire(50_000_000)!;
    const store = createBlobStore(
      f.byteStore,
      f.metadata,
      opts({ admission, admissionWaitMs: 100 }),
    );
    const pending = store.stage(ctx, streamOf([enc.encode('wait')]), {
      maxBytes: 50_000_000,
      mediaType: 'application/gzip',
    });
    const result = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(f.objects.size).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ value: { size: 4 } });
    expect(admission.inFlightBytes()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['sha256', 'size', 'mediaType'] as const)(
  'refuses a staged capability with altered %s',
  async (field) => {
    const f = stagingFixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const staged = await store.stage(ctx, streamOf([enc.encode('identity')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    });
    const altered = {
      ...staged,
      [field]: field === 'size' ? 9 : field === 'sha256' ? 'a'.repeat(64) : 'text/plain',
    };
    await expect(store.openStaged(ctx, altered)).rejects.toBeInstanceOf(BlobValidationError);
    await expect(store.promote(ctx, altered, { refetchable: false })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
    await expect(store.discard(ctx, altered)).rejects.toBeInstanceOf(BlobValidationError);
    expect(f.objects.has(staged.handle)).toBe(true);
  },
);

it.each(['size', 'mediaType', 'purgeAfter'] as const)(
  'refuses staged publication metadata with conflicting %s',
  async (field) => {
    const f = stagingFixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const staged = await store.stage(ctx, streamOf([enc.encode('identity')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    });
    f.metadata.publish = async () => ({
      ...staged,
      generation: 'g',
      purgeAfter: null,
      [field]:
        field === 'size' ? 9 : field === 'mediaType' ? 'text/plain' : '2099-01-01T00:00:00.000Z',
    });
    await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
      BlobConflictError,
    );
  },
);

it('refuses a staged byte adapter reporting a different consumed size', async () => {
  const f = stagingFixture();
  const put = f.byteStore.putStaged;
  f.byteStore.putStaged = async (...args) => ({ ...(await put(...args)), size: 1 });
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  await expect(
    store.stage(ctx, streamOf([enc.encode('bytes')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    }),
  ).rejects.toBeInstanceOf(BlobSizeMismatchError);
  expect(f.objects.size).toBe(0);
});

it('refuses stale staged promotion when physical size changed before retry', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await store.stage(ctx, streamOf([enc.encode('race')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  const publish = f.metadata.publish;
  let attempts = 0;
  f.metadata.publish = async (...args) => {
    if (++attempts === 1) {
      f.objects.set(stagedStorageKey(staged.handle, staged.sha256), {
        bytes: enc.encode('changed'),
        mediaType: staged.mediaType,
      });
      return null;
    }
    return publish(...args);
  };
  await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
    BlobSizeMismatchError,
  );
});

it('refuses staged admission at the wait deadline and cancels the waiting source', async () => {
  vi.useFakeTimers();
  const admission = createBlobUploadAdmission();
  const release = admission.tryAcquire(50_000_000)!;
  try {
    const f = stagingFixture();
    const store = createBlobStore(
      f.byteStore,
      f.metadata,
      opts({ admission, admissionWaitMs: 100 }),
    );
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    let result: unknown;
    const pending = store
      .stage(ctx, body, { maxBytes: 50_000_000, mediaType: 'application/gzip' })
      .then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          result = error;
        },
      );
    await vi.advanceTimersByTimeAsync(110);
    expect(result).toBeInstanceOf(BlobAdmissionError);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.objects.size).toBe(0);
  } finally {
    release();
    vi.useRealTimers();
  }
});

it('Round 3 releases admission when staging receives a locked stream', async () => {
  const f = stagingFixture();
  const release = vi.fn();
  const store = createBlobStore(
    f.byteStore,
    f.metadata,
    opts({
      admission: {
        budgetBytes: 64 * 1024 * 1024,
        inFlightBytes: () => 0,
        tryAcquire: () => release,
      },
    }),
  );
  const body = streamOf([]);
  const reader = body.getReader();
  await expect(
    store.stage(ctx, body, { maxBytes: 10, mediaType: 'application/gzip' }),
  ).rejects.toThrow();
  expect(release).toHaveBeenCalledOnce();
  reader.releaseLock();
});
it.each(['reserve', 'adapter', 'publish', 'input'])(
  'Round 3 forgets the capability after a %s promotion failure',
  async (failure) => {
    const f = stagingFixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const staged = await store.stage(ctx, streamOf([enc.encode('stage')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    });
    if (failure === 'reserve')
      f.metadata.reserve = async () => {
        throw new BlobBusyError();
      };
    if (failure === 'adapter')
      f.byteStore.promote = async () => {
        throw new Error('failed');
      };
    if (failure === 'publish')
      f.metadata.publish = async () => {
        throw new Error('failed');
      };
    await expect(
      store.promote(ctx, staged, { refetchable: failure === 'input' ? true : false } as never),
    ).rejects.toThrow();
    await expect(store.openStaged(ctx, staged)).rejects.toBeInstanceOf(BlobValidationError);
  },
);
it('Round 3 expires an abandoned capability on access', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await store.stage(ctx, streamOf([enc.encode('stage')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 3600 * 1000 + 1);
  try {
    await expect(store.openStaged(ctx, staged)).rejects.toBeInstanceOf(BlobValidationError);
  } finally {
    now.mockRestore();
  }
});
it('Round 3 cached dedup narrows refetchability and preserves key', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const bytes = enc.encode('cached');
  const key = sha(bytes);
  const original = await store.put(ctx, key, streamOf([bytes]), {
    size: bytes.length,
    mediaType: 'application/gzip',
    refetchable: true,
  });
  const reserve = vi.spyOn(f.metadata, 'reserve');
  const staged = await store.stage(ctx, streamOf([bytes]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  const dedup = await store.promote(ctx, staged, { refetchable: false });
  expect(dedup).toEqual({ ...original, generation: dedup.generation });
  expect(dedup.generation).not.toBe(original.generation);
  expect(f.rowRefetchable(key)).toBe(false);
  expect(reserve).toHaveBeenCalledExactlyOnceWith(ctx, key);
  expect(f.objects.has(blobStorageKey(ctx.orgId, key))).toBe(true);
  expect(f.objects.has(stagedStorageKey(staged.handle, key))).toBe(false);
});
it('Round 3 reads the stored npm key once for get head and probe', async () => {
  const f = stagingFixture();
  const bytes = enc.encode('stored');
  const key = sha(bytes);
  const storageKey = `npm-publish/${blobStorageKey(ctx.orgId, key)}`;
  const row = {
    generation: 'g',
    sha256: key,
    size: bytes.length,
    mediaType: 'application/gzip',
    purgeAfter: null,
    storageKey,
  };
  f.objects.set(storageKey, { bytes, mediaType: row.mediaType });
  f.metadata.find = async () => row;
  f.metadata.inspect = async () => ({ info: row, storageKey, purging: false });
  const get = vi.spyOn(f.byteStore, 'get');
  const head = vi.spyOn(f.byteStore, 'head');
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  await drain((await store.get(ctx, key))!.body);
  await store.head(ctx, key);
  await createBlobProbe(f.byteStore, f.metadata, {
    hashStream: async (body) =>
      new Uint8Array(
        createHash('sha256')
          .update(await drain(body))
          .digest(),
      ),
  }).probe(ctx, key);
  expect(get.mock.calls.map(([k]) => k)).toEqual([storageKey, storageKey]);
  expect(head.mock.calls.map(([k]) => k)).toEqual([storageKey]);
});

it('expires abandoned capabilities while idle and releases the timer', async () => {
  vi.useFakeTimers();
  try {
    const f = stagingFixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const staged = await store.stage(ctx, streamOf([enc.encode('abandoned')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    });
    const started = Date.now();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(vi.getTimerCount()).toBe(1);
    await drain(await store.openStaged(ctx, staged));
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(started);
    await expect(store.openStaged(ctx, staged)).rejects.toBeInstanceOf(BlobValidationError);
  } finally {
    vi.useRealTimers();
  }
});
it.each(['discard', 'promote', 'failed discard', 'failed promote'] as const)(
  'releases the capability timer after %s',
  async (outcome) => {
    vi.useFakeTimers();
    try {
      const f = stagingFixture();
      const store = createBlobStore(f.byteStore, f.metadata, opts());
      const staged = await store.stage(ctx, streamOf([enc.encode('timer')]), {
        maxBytes: 10,
        mediaType: 'application/gzip',
      });
      expect(vi.getTimerCount()).toBe(1);
      const failure = new Error('storage unavailable');
      if (outcome === 'failed discard')
        f.byteStore.discardStaged = async () => {
          throw failure;
        };
      if (outcome === 'failed promote')
        f.byteStore.promote = async () => {
          throw failure;
        };
      const result = outcome.includes('discard')
        ? store.discard(ctx, staged)
        : store.promote(ctx, staged, { refetchable: false });
      if (outcome.startsWith('failed')) await expect(result).rejects.toBe(failure);
      else await result;
      expect(vi.getTimerCount()).toBe(0);
      await expect(store.openStaged(ctx, staged)).rejects.toBeInstanceOf(BlobValidationError);
    } finally {
      vi.useRealTimers();
    }
  },
);
it('keeps staged capabilities within their owning store instance', async () => {
  const f = stagingFixture();
  const owner = createBlobStore(f.byteStore, f.metadata, opts());
  const sibling = createBlobStore(f.byteStore, f.metadata, opts());
  const staged = await owner.stage(ctx, streamOf([enc.encode('owned')]), {
    maxBytes: 10,
    mediaType: 'application/gzip',
  });
  await expect(sibling.openStaged(ctx, staged)).rejects.toBeInstanceOf(BlobValidationError);
  await owner.discard(ctx, staged);
});
it('Round 3 encodes organization segments consistently for staging and content keys', () => {
  expect(orgStorageSegment(ctx.orgId)).toBe(
    blobStorageKey(ctx.orgId, sha(new Uint8Array())).split('/')[1],
  );
});

it.each(['size', 'mediaType', 'purgeAfter', 'missing bytes'])(
  'Round 3 cached dedup refuses the shortcut for %s',
  async (field) => {
    const f = stagingFixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const staged = await store.stage(ctx, streamOf([enc.encode('stage')]), {
      maxBytes: 10,
      mediaType: 'application/gzip',
    });
    const row = {
      generation: 'g',
      sha256: staged.sha256,
      size: staged.size,
      mediaType: staged.mediaType,
      purgeAfter: null as string | null,
    };
    if (field === 'size') row.size++;
    if (field === 'mediaType') row.mediaType = 'application/zip';
    if (field === 'purgeAfter') row.purgeAfter = '2020-01-01T00:00:00.000Z';
    f.metadata.find = async () => row;
    f.byteStore.head = async () => (field === 'missing bytes' ? null : row);
    f.metadata.reserve = vi.fn(async () => {
      throw new BlobBusyError();
    });
    await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
      BlobBusyError,
    );
    expect(f.metadata.reserve).toHaveBeenCalledOnce();
  },
);

it('Round 4 dedup refuses a purge claim acquired after the live lookup', async () => {
  const f = stagingFixture();
  const store = createBlobStore(f.byteStore, f.metadata, opts());
  const bytes = enc.encode('dedup purge race');
  const key = sha(bytes);
  await store.put(ctx, key, streamOf([bytes]), {
    size: bytes.length,
    mediaType: 'application/gzip',
    refetchable: true,
  });
  const staged = await store.stage(ctx, streamOf([bytes]), {
    maxBytes: 1024,
    mediaType: 'application/gzip',
  });
  const head = f.byteStore.head;
  f.byteStore.head = async (physicalKey) => {
    const result = await head(physicalKey);
    await f.lifecycle.softDelete(ctx, key, { removedAt: '2020-01-01T00:00:00.000Z' });
    expect(await f.lifecycle.claimPurge(ctx, key)).not.toBeNull();
    return result;
  };
  await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
    BlobBusyError,
  );
});

it.each(['missing', 'scheduled'] as const)(
  'Round 4 dedup refuses a %s row after its reservation',
  async (state) => {
    const f = stagingFixture();
    const store = createBlobStore(f.byteStore, f.metadata, opts());
    const bytes = enc.encode('dedup reservation recheck');
    const key = sha(bytes);
    await store.put(ctx, key, streamOf([bytes]), {
      size: bytes.length,
      mediaType: 'application/gzip',
      refetchable: true,
    });
    const staged = await store.stage(ctx, streamOf([bytes]), {
      maxBytes: 1024,
      mediaType: 'application/gzip',
    });
    const reserve = f.metadata.reserve;
    f.metadata.reserve = async (org, digest) => {
      const generation = await reserve(org, digest);
      const row = await f.metadata.find(org, digest);
      f.metadata.narrowRefetchable = async () =>
        state === 'missing' ? null : { ...row!, purgeAfter: '2020-01-01T00:00:00.000Z' };
      return generation;
    };
    await expect(store.promote(ctx, staged, { refetchable: false })).rejects.toBeInstanceOf(
      BlobBusyError,
    );
  },
);

it.each(['publication failure', 'concurrent winner'])(
  'Round 5 counts and logs cleanup failure after %s without changing the outcome',
  async (outcome) => {
    const f = stagingFixture();
    const log = vi.fn();
    const counter = vi.fn();
    const store = createBlobStore(
      f.byteStore,
      f.metadata,
      opts({
        observability: { log, counter, histogram: vi.fn() },
      }),
    );
    const stage = () =>
      store.stage(ctx, streamOf([enc.encode('cleanup failure')]), {
        maxBytes: 1024,
        mediaType: 'application/gzip',
      });
    const loser = await stage();
    if (outcome === 'publication failure') {
      f.fail.publish = new Error('private database details');
    } else {
      const winner = await stage();
      const find = f.metadata.find;
      f.metadata.find = async (...args) => {
        const row = await find(...args);
        return row === null
          ? null
          : { ...row, storageKey: stagedStorageKey(winner.handle, winner.sha256) };
      };
      const promote = f.byteStore.promote;
      f.byteStore.promote = async (...args) => {
        await promote(...args);
        if (args[0] === loser.handle) await store.promote(ctx, winner, { refetchable: false });
      };
    }
    f.byteStore.remove = async () => {
      throw new Error('private storage details');
    };
    const promotion = store.promote(ctx, loser, { refetchable: false });
    if (outcome === 'publication failure') await expect(promotion).rejects.toBe(f.fail.publish);
    else expect(await promotion).toEqual(await store.head(ctx, loser.sha256));
    expect(counter).toHaveBeenCalledExactlyOnceWith('pb.blob.promotion_cleanup', {
      outcome: 'error',
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'promoted_blob_cleanup_failed',
    });
  },
);

it('admits a 20 MiB on-demand archive while a small publish is staging', async () => {
  const f = stagingFixture();
  const admission = createBlobUploadAdmission();
  const store = createBlobStore(f.byteStore, f.metadata, opts({ admission, admissionWaitMs: 0 }));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const putStaged = f.byteStore.putStaged;
  f.byteStore.putStaged = async (...args) => {
    await pending;
    return putStaged(...args);
  };
  const staging = store.stage(ctx, streamOf([enc.encode('small')]), {
    maxBytes: 1000,
    mediaType: 'application/gzip',
  });
  try {
    const bytes = new Uint8Array(20 * 1024 * 1024);
    const result = await store.put(ctx, sha(bytes), streamOf([bytes]), {
      size: bytes.length,
      mediaType: 'application/gzip',
      refetchable: true,
    });
    expect(result.size).toBe(bytes.length);
    expect(admission.inFlightBytes()).toBe(1000);
  } finally {
    finish();
  }
  await store.discard(ctx, await staging);
});
