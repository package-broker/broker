import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import {
  BlobDigestMismatchError,
  BlobSizeMismatchError,
  createBlobStore,
  createBlobUploadAdmission,
  parseSha256,
  type BlobMetadataPort,
  type ByteStore,
  type BlobInfo,
  type BlobStore,
  type Sha256,
} from '../platform/blob.js';
import type { Codecs, DigestAlgorithm } from '../platform/codec.js';
import {
  TwoPassLimitError,
  UpstreamUnstableError,
  twoPassPut,
  type TwoPassOptions,
} from './two-pass-put.js';

const ctx = orgContext('01J0ACME000000000000000000');
const enc = new TextEncoder();
const hex = (alg: string, bytes: Uint8Array): string => createHash(alg).update(bytes).digest('hex');

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

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

function fakeStore(): { store: BlobStore; stored: Map<string, Uint8Array>; puts: number[] } {
  const stored = new Map<string, Uint8Array>();
  const puts: number[] = [];
  const store: BlobStore = {
    async put(_ctx, key, body, input): Promise<BlobInfo> {
      puts.push(input.size);
      const bytes = await drain(body);
      if (bytes.length !== input.size) throw new BlobSizeMismatchError();
      if (hex('sha256', bytes) !== key)
        throw new BlobDigestMismatchError(key, hex('sha256', bytes));
      stored.set(key, bytes);
      return { sha256: key, size: bytes.length, mediaType: input.mediaType, purgeAfter: null };
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
  };
  return { store, stored, puts };
}

const base = { mediaType: 'application/zip', refetchable: true, maxBytes: 1024, codecs };
const opts = (extra: Partial<TwoPassOptions> = {}): TwoPassOptions => ({ ...base, ...extra });

describe('twoPassPut', () => {
  it('stores a body of unknown length with the pass-1 digest and size', async () => {
    const body = [enc.encode('hello '), enc.encode('world')];
    const f = fakeStore();
    let opens = 0;
    const result = await twoPassPut(ctx, async () => (opens++, streamOf(body)), f.store, opts());
    const all = enc.encode('hello world');
    expect(result.status).toBe('stored');
    expect(result.size).toBe(all.length);
    expect(Buffer.from(result.digests.sha256).toString('hex')).toBe(hex('sha256', all));
    expect(Buffer.from(result.digests.sha1).toString('hex')).toBe(hex('sha1', all));
    expect(Buffer.from(result.digests.sha512).toString('hex')).toBe(hex('sha512', all));
    expect(f.stored.get(hex('sha256', all))).toEqual(all);
    expect(opens).toBe(2);
  });

  it('counts the bytes of both passes', async () => {
    const f = fakeStore();
    const counts: number[] = [];
    await twoPassPut(
      ctx,
      async () => streamOf([enc.encode('abcd')]),
      f.store,
      opts({
        onUpstreamBytes: { add: (n = 1) => counts.push(n) },
      }),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
  });

  it('stores nothing and skips pass 2 when verifyFirstPass refuses', async () => {
    const f = fakeStore();
    let opens = 0;
    const result = await twoPassPut(
      ctx,
      async () => (opens++, streamOf([enc.encode('abc')])),
      f.store,
      opts({ verifyFirstPass: () => false }),
    );
    expect(result.status).toBe('rejected');
    expect(opens).toBe(1);
    expect(f.puts).toHaveLength(0);
    expect(f.stored.size).toBe(0);
  });

  it('retries both passes once and then throws when pass 2 keeps differing', async () => {
    const f = fakeStore();
    let opens = 0;
    const open = async (): Promise<ReadableStream<Uint8Array>> => {
      const n = opens++;
      return streamOf([enc.encode(n % 2 === 0 ? 'first-pass' : 'other-pass')]);
    };
    await expect(twoPassPut(ctx, open, f.store, opts())).rejects.toThrow(UpstreamUnstableError);
    expect(opens).toBe(4);
    expect(f.stored.size).toBe(0);
  });

  it('succeeds when the retry is stable', async () => {
    const f = fakeStore();
    let opens = 0;
    const open = async (): Promise<ReadableStream<Uint8Array>> => {
      const n = opens++;
      return streamOf([enc.encode(n === 1 ? 'drifte' : 'steady')]);
    };
    const result = await twoPassPut(ctx, open, f.store, opts());
    expect(result.status).toBe('stored');
    expect(opens).toBe(4);
    expect(f.stored.get(hex('sha256', enc.encode('steady')))).toEqual(enc.encode('steady'));
  });

  it('does not treat an unrelated store failure as instability', async () => {
    const failure = new Error('disk');
    const store: BlobStore = {
      put: async (_c, _k, body) => {
        await body.cancel();
        throw failure;
      },
      get: async () => null,
      head: async () => null,
    };
    let opens = 0;
    await expect(
      twoPassPut(ctx, async () => (opens++, streamOf([enc.encode('abc')])), store, opts()),
    ).rejects.toBe(failure);
    expect(opens).toBe(2);
  });

  it('refuses a body over maxBytes in pass 1 without a second pass', async () => {
    const f = fakeStore();
    let opens = 0;
    await expect(
      twoPassPut(
        ctx,
        async () => (opens++, streamOf([new Uint8Array(600), new Uint8Array(600)])),
        f.store,
        opts(),
      ),
    ).rejects.toThrow(TwoPassLimitError);
    expect(opens).toBe(1);
    expect(f.puts).toHaveLength(0);
  });

  it('exposes a branded sha256 key to the store', async () => {
    let seen: Sha256 | null = null;
    const store: BlobStore = {
      put: async (_c, key, body, input) => {
        seen = key;
        await drain(body);
        return { sha256: key, size: input.size, mediaType: input.mediaType, purgeAfter: null };
      },
      get: async () => null,
      head: async () => null,
    };
    await twoPassPut(ctx, async () => streamOf([enc.encode('x')]), store, opts());
    expect(seen).toBe(parseSha256(hex('sha256', enc.encode('x'))));
  });

  it('propagates pass-2 growth past maxBytes as a size mismatch', async () => {
    const f = fakeStore();
    let opens = 0;
    const open = async (): Promise<ReadableStream<Uint8Array>> =>
      streamOf([new Uint8Array(opens++ % 2 === 0 ? 100 : 2000)]);
    await expect(twoPassPut(ctx, open, f.store, opts())).rejects.toThrow(BlobSizeMismatchError);
    expect(opens).toBe(2);
    expect(f.stored.size).toBe(0);
  });

  it('fails instead of hanging when the pass-2 source errors', async () => {
    const f = fakeStore();
    const boom = new Error('socket');
    let opens = 0;
    const open = async (): Promise<ReadableStream<Uint8Array>> =>
      opens++ % 2 === 0
        ? streamOf([enc.encode('abc')])
        : new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode('a'));
              c.error(boom);
            },
          });
    const taps: Promise<unknown>[] = [];
    const recording: Pick<Codecs, 'digestTap'> = {
      digestTap: (algs) => {
        const tap = codecs.digestTap(algs);
        taps.push(tap.digests);
        return tap;
      },
    };
    await expect(twoPassPut(ctx, open, f.store, opts({ codecs: recording }))).rejects.toBe(boom);
    await expect(taps[taps.length - 1]).rejects.toBe(boom);
    expect(f.stored.size).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects maxBytes %s',
    async (maxBytes) => {
      const f = fakeStore();
      await expect(
        twoPassPut(ctx, async () => streamOf([enc.encode('a')]), f.store, opts({ maxBytes })),
      ).rejects.toThrow(RangeError);
    },
  );

  it('refuses a maxBytes above the platform blob cap', async () => {
    const f = fakeStore();
    let opens = 0;
    await expect(
      twoPassPut(
        ctx,
        async () => (opens++, streamOf([enc.encode('a')])),
        f.store,
        opts({ maxBytes: 64 * 1024 * 1024 + 1 }),
      ),
    ).rejects.toThrow(RangeError);
    expect(opens).toBe(0);
  });

  it('refuses a missing maxBytes', async () => {
    const f = fakeStore();
    const rest = { ...base, maxBytes: undefined } as unknown as TwoPassOptions;
    await expect(
      twoPassPut(ctx, async () => streamOf([enc.encode('a')]), f.store, rest),
    ).rejects.toThrow(RangeError);
  });

  it('surfaces a generic store failure after the last byte instead of calling it unstable', async () => {
    const failure = new Error('commit');
    const store: BlobStore = {
      put: async (_c, _k, body) => {
        await drain(body);
        throw failure;
      },
      get: async () => null,
      head: async () => null,
    };
    let opens = 0;
    await expect(
      twoPassPut(ctx, async () => (opens++, streamOf([enc.encode('abc')])), store, opts()),
    ).rejects.toBe(failure);
    expect(opens).toBe(2);
  });

  it.each([
    ['generic failure with differing bytes', () => new Error('disk'), 'xyz'],
    ['size mismatch with longer bytes', () => new BlobSizeMismatchError(), 'abcdef'],
    ['size mismatch with shorter bytes', () => new BlobSizeMismatchError(), 'a'],
  ] as const)('propagates %s without retrying', async (_name, makeError, second) => {
    const failure = makeError();
    const store: BlobStore = {
      put: async (_c, _k, body) => {
        await drain(body);
        throw failure;
      },
      get: async () => null,
      head: async () => null,
    };
    let opens = 0;
    await expect(
      twoPassPut(
        ctx,
        async () => streamOf([enc.encode(opens++ === 0 ? 'abc' : second)]),
        store,
        opts(),
      ),
    ).rejects.toBe(failure);
    expect(opens).toBe(2);
  });

  it('treats a typed digest mismatch from the store as instability', async () => {
    const store: BlobStore = {
      put: async (_c, _k, body) => {
        await body.cancel();
        throw new BlobDigestMismatchError('a'.repeat(64), 'b'.repeat(64));
      },
      get: async () => null,
      head: async () => null,
    };
    let opens = 0;
    const err = await twoPassPut(
      ctx,
      async () => (opens++, streamOf([enc.encode('abc')])),
      store,
      opts(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnstableError);
    expect((err as Error).cause).toBeInstanceOf(BlobDigestMismatchError);
    expect(opens).toBe(4);
  });

  it('stops on abort before opening again', async () => {
    const f = fakeStore();
    const ac = new AbortController();
    let opens = 0;
    await expect(
      twoPassPut(
        ctx,
        async () => {
          opens++;
          ac.abort();
          return streamOf([enc.encode('abc')]);
        },
        f.store,
        opts({ signal: ac.signal }),
      ),
    ).rejects.toBe(ac.signal.reason);
    expect(opens).toBe(1);
    expect(f.puts).toHaveLength(0);
  });

  it('detects same-size drift when the adapter stops at size bytes and throws', async () => {
    let opens = 0;
    const open = async (): Promise<ReadableStream<Uint8Array>> =>
      streamOf([enc.encode(opens++ % 2 === 0 ? 'aaaa' : 'bbbb')]);
    const store: BlobStore = {
      put: async (_c, _k, body, input) => {
        const reader = body.getReader();
        let got = 0;
        while (got < input.size) {
          const r = await reader.read();
          if (r.done) break;
          got += r.value.length;
        }
        throw new BlobDigestMismatchError('a'.repeat(64), 'b'.repeat(64));
      },
      get: async () => null,
      head: async () => null,
    };
    const err = await twoPassPut(ctx, open, store, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnstableError);
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(opens).toBe(4);
  });

  it('surfaces a store-side size mismatch when pass 2 delivered the expected bytes', async () => {
    const failure = new BlobSizeMismatchError();
    const store: BlobStore = {
      put: async (_c, _k, body) => {
        await drain(body);
        throw failure;
      },
      get: async () => null,
      head: async () => null,
    };
    let opens = 0;
    await expect(
      twoPassPut(ctx, async () => (opens++, streamOf([enc.encode('abc')])), store, opts()),
    ).rejects.toBe(failure);
    expect(opens).toBe(2);
  });

  describe('with the real blob store', () => {
    function realStore(): {
      store: BlobStore;
      objects: Map<string, Uint8Array>;
      find: (key: Sha256) => Promise<BlobInfo | null>;
    } {
      const objects = new Map<string, Uint8Array>();
      const rows = new Map<string, BlobInfo>();
      const byteStore: ByteStore = {
        async putVerified(key, body, input) {
          const bytes = await drain(body);
          if (bytes.length !== input.size) throw new Error('size');
          if (hex('sha256', bytes) !== input.sha256) throw new Error('digest');
          objects.set(key, bytes);
          return { size: bytes.length, mediaType: input.mediaType };
        },
        async get() {
          return null;
        },
        async head(key) {
          const o = objects.get(key);
          return o ? { size: o.length, mediaType: 'application/zip' } : null;
        },
        async remove() {},
      };
      const metadata: BlobMetadataPort = {
        reserve: async () => '1' as never,
        publish: async (_c, i) => {
          const info = { sha256: i.sha256, size: i.size, mediaType: i.mediaType, purgeAfter: null };
          rows.set(i.sha256, info);
          return info;
        },
        find: async (_c, key) => rows.get(key) ?? null,
        narrowRefetchable: async () => null,
        inspect: async () => null,
      };
      const store = createBlobStore(byteStore, metadata, {
        admission: createBlobUploadAdmission(),
      });
      return {
        store,
        objects,
        find: (key) => metadata.find(ctx, key),
      };
    }

    it.each([
      ['longer', 'abcdefgh', BlobSizeMismatchError],
      ['shorter', 'ab', BlobSizeMismatchError],
      ['same-size', 'abcX', Error],
    ])('stores nothing when pass 2 is %s', async (_n, drift, errorType) => {
      const r = realStore();
      let opens = 0;
      const open = async (): Promise<ReadableStream<Uint8Array>> =>
        streamOf([enc.encode(opens++ % 2 === 0 ? 'abcd' : drift)]);
      await expect(twoPassPut(ctx, open, r.store, opts())).rejects.toThrow(errorType);
      expect(opens).toBe(2);
      expect(r.objects.size).toBe(0);
      expect(await r.store.head(ctx, parseSha256(hex('sha256', enc.encode('abcd'))))).toBeNull();
      expect(await r.find(parseSha256(hex('sha256', enc.encode('abcd'))))).toBeNull();
    });
  });
});
