import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BlobTooLargeError,
  BlobValidationError,
  BlobSizeMismatchError,
  parseSha256,
} from '@package-broker/core/platform/blob';
import { createR2ByteStore, type FixedLengthStreamLike, type R2BucketLike } from './r2.js';

class Digest extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor() {
    const hash = createHash('sha256');
    let resolve!: (value: ArrayBuffer) => void;
    let reject!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        const bytes = hash.digest();
        resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      abort: reject,
    });
    this.digest = digest;
  }
}
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal('crypto', { DigestStream: Digest });
  const sizes: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const abort = vi.fn(async () => {});
  const complete = vi.fn(async () => ({}));
  const uploadPart = vi.fn(async (partNumber: number, bytes: Uint8Array) => {
    sizes.push(bytes.length);
    peak = Math.max(peak, ++inFlight);
    await Promise.resolve();
    inFlight--;
    return { partNumber, etag: 'part' + partNumber };
  });
  const bucket = {
    createMultipartUpload: async () => ({ uploadPart, abort, complete }),
    delete: vi.fn(async () => {}),
    put: vi.fn(async (_key: string, body: unknown) => {
      if (body instanceof ReadableStream) await new Response(body).arrayBuffer();
      return {};
    }),
  } as unknown as R2BucketLike;
  const options = {
    fixedLengthStream: () =>
      new TransformStream<Uint8Array, Uint8Array>() as unknown as FixedLengthStreamLike,
  };
  return {
    options,
    store: createR2ByteStore(bucket, options),
    sizes,
    abort,
    complete,
    peak: () => peak,
    bucket,
    uploadPart,
  };
}
const handle = 'staging/61/01J00000000000000000000001' as never;
function source(size: number, cancelled = () => {}) {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (offset === size) return c.close();
        const n = Math.min(65537, size - offset);
        offset += n;
        c.enqueue(new Uint8Array(n).fill(3));
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
}
it('assembles equal 8 MiB parts with one part in flight and a shorter final part', async () => {
  const f = fixture();
  const size = 2 * 8 * 1024 * 1024 + 13;
  const value = await f.store.putStaged(handle, source(size), size, 'application/gzip');
  expect(f.sizes).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 13]);
  expect(f.peak()).toBe(1);
  expect(value).toEqual({
    size,
    sha256: createHash('sha256').update(new Uint8Array(size).fill(3)).digest('hex'),
  });
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.abort).not.toHaveBeenCalled();
});
it('aborts an oversized multipart upload and cancels the source before completing it', async () => {
  const f = fixture();
  const cancel = vi.fn();
  await expect(
    f.store.putStaged(handle, source(1_000_000, cancel), 100_000, 'application/gzip'),
  ).rejects.toBeInstanceOf(BlobTooLargeError);
  expect(f.abort).toHaveBeenCalledOnce();
  expect(f.complete).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('bounds staged listing and sends the organization prefix to the bucket', async () => {
  const objects = Array.from({ length: 51 }, (_, n) => ({
    key: `staging/61/01J000000000000000000${String(n).padStart(5, '0')}`,
    uploaded: new Date('2020-01-01T00:00:00.000Z'),
  }));
  const list = vi.fn(async () => ({ objects, truncated: false }));
  const store = createR2ByteStore({ list } as unknown as R2BucketLike);
  expect(await store.listStaged('2026-01-01T00:00:00.000Z', 'staging/61/')).toHaveLength(50);
  expect(list).toHaveBeenCalledExactlyOnceWith({ prefix: 'staging/61/' });
});

it.each(['discard', 'promote'])(
  'aborts an active multipart upload on %s failure cleanup',
  async (operation) => {
    const f = fixture();
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        entered();
      },
      cancel,
    });
    const pending = f.store.putStaged(handle, body, 10, 'application/gzip');
    const refused = expect(pending).rejects.toBeInstanceOf(BlobValidationError);
    await reading;
    if (operation === 'discard') await f.store.discardStaged(handle);
    else {
      f.bucket.get = async () => null;
      await expect(
        f.store.promote(handle, parseSha256('a'.repeat(64)), 1, 'application/gzip'),
      ).rejects.toBeInstanceOf(BlobSizeMismatchError);
    }
    expect(f.abort).toHaveBeenCalled();
    await refused;
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.complete).not.toHaveBeenCalled();
  },
);

it('aborts and cancels the source when a multipart part fails', async () => {
  const f = fixture();
  const cancel = vi.fn();
  f.uploadPart.mockRejectedValueOnce(new Error('part failed'));
  await expect(
    f.store.putStaged(handle, source(10_000_000, cancel), 10_000_000, 'application/gzip'),
  ).rejects.toThrow('part failed');
  expect(f.abort).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.complete).not.toHaveBeenCalled();
});

it('aborts an upload when multipart completion fails', async () => {
  const f = fixture();
  f.complete.mockRejectedValueOnce(new Error('complete failed'));
  await expect(f.store.putStaged(handle, source(1), 1, 'application/gzip')).rejects.toThrow(
    'complete failed',
  );
  expect(f.abort).toHaveBeenCalledOnce();
});

it('aborts the multipart upload when digest initialization fails', async () => {
  const f = fixture();
  vi.stubGlobal('crypto', {
    DigestStream: class {
      constructor() {
        throw new Error('digest failed');
      }
    },
  });
  await expect(f.store.putStaged(handle, source(1), 1, 'application/gzip')).rejects.toThrow(
    'digest failed',
  );
  expect(f.abort).toHaveBeenCalledOnce();
});

it.each([-1, 0.5, NaN])(
  'refuses invalid R2 staging cap %s before creating an upload',
  async (cap) => {
    const f = fixture();
    await expect(
      f.store.putStaged(handle, source(1), cap, 'application/gzip'),
    ).rejects.toBeInstanceOf(BlobValidationError);
    expect(f.sizes).toEqual([]);
    expect(f.abort).not.toHaveBeenCalled();
  },
);

it('refuses R2 promotion with a different physical size', async () => {
  const f = fixture();
  f.bucket.get = async () => ({ size: 2, body: source(2), httpMetadata: {} }) as never;
  await expect(
    f.store.promote(handle, parseSha256('a'.repeat(64)), 1, 'application/gzip'),
  ).rejects.toBeInstanceOf(BlobSizeMismatchError);
});

it('refuses repeated R2 listing cursors and skips fresh or invalid objects', async () => {
  let pages = 0;
  const list = vi.fn(async () => ({
    objects: [
      { key: handle, uploaded: new Date('2099-01-01T00:00:00.000Z') },
      { key: 'staging/61/invalid', uploaded: new Date('2020-01-01T00:00:00.000Z') },
    ],
    truncated: ++pages < 3,
    cursor: 'same',
  }));
  const store = createR2ByteStore({ list } as unknown as R2BucketLike);
  await expect(store.listStaged('2026-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(
    BlobValidationError,
  );
  expect(list).toHaveBeenCalledTimes(2);
});

it('omits fresh and malformed R2 staging objects from a completed listing', async () => {
  const store = createR2ByteStore({
    list: async () => ({
      objects: [
        { key: handle, uploaded: new Date('2099-01-01T00:00:00.000Z') },
        { key: 'staging/61/invalid', uploaded: new Date('2020-01-01T00:00:00.000Z') },
      ],
      truncated: false,
    }),
  } as unknown as R2BucketLike);
  expect(await store.listStaged('2026-01-01T00:00:00.000Z')).toEqual([]);
});

it('refuses an invalid R2 staging listing cutoff before reading the bucket', async () => {
  const list = vi.fn();
  const store = createR2ByteStore({ list } as unknown as R2BucketLike);
  await expect(store.listStaged('invalid')).rejects.toBeInstanceOf(BlobValidationError);
  expect(list).not.toHaveBeenCalled();
});

it('cancels staged R2 bytes when promotion refuses their physical size', async () => {
  const f = fixture();
  const cancel = vi.fn();
  f.bucket.get = async () => ({ size: 2, body: source(2, cancel), httpMetadata: {} }) as never;
  await expect(
    f.store.promote(handle, parseSha256('a'.repeat(64)), 1, 'application/gzip'),
  ).rejects.toBeInstanceOf(BlobSizeMismatchError);
  expect(cancel).toHaveBeenCalledOnce();
});

it('Round 3 gives each R2 part its own backing buffer', async () => {
  const f = fixture();
  const size = 8 * 1024 * 1024 + 13;
  await f.store.putStaged(handle, source(size), size, 'application/gzip');
  const [first, second] = f.uploadPart.mock.calls.map(([, bytes]) => bytes);
  expect(first!.buffer === second!.buffer).toBe(false);
});
it('Round 3 R2 promotion uses the captured verifier and consumes staging', async () => {
  const f = fixture();
  f.options.fixedLengthStream = () => {
    throw new Error('options read again');
  };
  const body = new Uint8Array([3]);
  const sha256 = parseSha256(createHash('sha256').update(body).digest('hex'));
  f.bucket.get = async () => ({ size: 1, body: source(1), httpMetadata: {} }) as never;
  f.bucket.head = async () => null;
  await f.store.promote(handle, sha256, 1, 'application/gzip');
  expect(f.bucket.delete).toHaveBeenCalledWith(handle);
});

it('Round 4 allocates no spare R2 buffer during or after the final flush', async () => {
  const f = fixture();
  const Native = Uint8Array;
  let allocations = 0;
  vi.stubGlobal(
    'Uint8Array',
    new Proxy(Native, {
      construct(target, args) {
        if (args[0] === 8 * 1024 * 1024) allocations++;
        return Reflect.construct(target, args);
      },
    }),
  );
  f.uploadPart.mockImplementation(async (partNumber) => {
    expect(allocations).toBe(partNumber);
    return { partNumber, etag: 'part' };
  });
  await f.store.putStaged(
    handle,
    source(8 * 1024 * 1024 + 13),
    9 * 1024 * 1024,
    'application/gzip',
  );
  expect(allocations).toBe(2);
});
it('Round 4 R2 promotion failure keeps completed staging', async () => {
  const f = fixture();
  f.bucket.get = async () => ({ size: 2, body: source(2), httpMetadata: {} }) as never;
  await expect(
    f.store.promote(handle, parseSha256('a'.repeat(64)), 1, 'application/gzip'),
  ).rejects.toBeInstanceOf(BlobSizeMismatchError);
  expect(f.bucket.delete).not.toHaveBeenCalled();
});
