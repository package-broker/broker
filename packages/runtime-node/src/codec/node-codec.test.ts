import { randomBytes } from 'node:crypto';
import { deflateRawSync, deflateSync, gzipSync, inflateRawSync } from 'node:zlib';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type DigestAlgorithm,
} from '@package-broker/core/platform/codec';
import { describe, expect, it, vi } from 'vitest';
import { nodeCodecs } from './node-codec.js';

const swap = vi.hoisted(() => ({ deflateRawAsGunzip: false }));
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    createDeflateRaw: (...args: Parameters<typeof actual.createDeflateRaw>) =>
      swap.deflateRawAsGunzip ? actual.createGunzip() : actual.createDeflateRaw(...args),
  };
});

const ALGS: readonly DigestAlgorithm[] = ['sha1', 'sha256', 'sha384', 'sha512'];
const EXPECTED: Record<DigestAlgorithm, string> = {
  sha1: '3e7e19ea8f559bd1f5c97e46f0ae082c4bcd6244',
  sha256: 'fb1907e541f9c81501e95cc95fbfacb263bab1990ae9b54272673d5107511d52',
  sha384:
    'f7c387e71f3cbd4e27f8df78c05b2600c81264bf16246a488832beb73d2cfc603c13de0441b245f41fff87f1f70d47bc',
  sha512:
    'c992c4e85caf0961560f3da2b47ee23d3c261b4fae3e9fe9bc6e4a5b7e026d9f74d8a396443d4564be77a575201d3fb8285f2fc332f6623442cb3817573ad0e5',
};
const message = Uint8Array.from({ length: 70 }, (_, i) => (i * 7 + 3) & 0xff);

async function run(
  transform: ReadableWritablePair<Uint8Array, Uint8Array>,
  chunks: readonly Uint8Array[],
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
}

describe('nodeCodecs digestTap', () => {
  it('known answers for the empty message', async () => {
    const { transform, digests } = nodeCodecs.digestTap(ALGS);
    await run(transform, []);
    const d = await digests;
    expect(Buffer.from(d.sha1).toString('hex')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(Buffer.from(d.sha256).toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  for (let split = 0; split <= message.length; split++) {
    it(`matches the known answers with the 70-byte input split at ${split}`, async () => {
      const { transform, digests } = nodeCodecs.digestTap(ALGS);
      const out = await run(transform, [message.subarray(0, split), message.subarray(split)]);
      expect(out).toEqual(message);
      const d = await digests;
      for (const alg of ALGS) {
        expect(Buffer.from(d[alg]).toString('hex')).toBe(EXPECTED[alg]);
      }
    });
  }

  it('does not settle digests before the writable closes', async () => {
    const { transform, digests } = nodeCodecs.digestTap(['sha256']);
    const writer = transform.writable.getWriter();
    const reading = new Response(transform.readable).arrayBuffer();
    await writer.write(message);
    let settled = false;
    void digests.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    await writer.close();
    await reading;
    expect(Buffer.from((await digests).sha256).toString('hex')).toBe(EXPECTED.sha256);
  });

  it('rejects digests when the source errors through pipeThrough', async () => {
    const { transform, digests } = nodeCodecs.digestTap(['sha256']);
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(message);
        c.error(new Error('upstream failed'));
      },
    });
    await expect(new Response(source.pipeThrough(transform)).arrayBuffer()).rejects.toThrow(
      'upstream failed',
    );
    await expect(digests).rejects.toThrow('upstream failed');
  });

  it('drives reads by pull', async () => {
    const { transform } = nodeCodecs.digestTap(['sha256']);
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(message);
      },
    });
    const reader = source.pipeThrough(transform).getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 20));
    expect(pulls).toBeLessThanOrEqual(4);
    await reader.cancel();
  });

  it('rejects digests when the stream is cancelled', async () => {
    const { transform, digests } = nodeCodecs.digestTap(['sha256']);
    const reader = transform.readable.getReader();
    await reader.cancel(new Error('stop'));
    await expect(digests).rejects.toThrow('stop');
  });

  it('rejects digests when the writer aborts', async () => {
    const { transform, digests } = nodeCodecs.digestTap(['sha256']);
    await transform.writable.getWriter().abort(new Error('boom'));
    await expect(digests).rejects.toThrow('boom');
  });
});

describe('nodeCodecs inflateConsumed', () => {
  const payload = Buffer.from('packfile object '.repeat(40));
  const stream = deflateSync(payload);

  it('returns the exact consumed length when trailing bytes follow', () => {
    const trailer = Buffer.from('NEXT-OBJECT-BYTES');
    const r = nodeCodecs.inflateConsumed(Buffer.concat([stream, trailer]), 10_000);
    expect(r.consumed).toBe(stream.length);
    expect(Buffer.from(r.data)).toEqual(payload);
  });

  it('accepts output exactly at the limit', () => {
    expect(nodeCodecs.inflateConsumed(stream, payload.length).data.length).toBe(payload.length);
  });

  it('throws CodecLimitError past maxOutput', () => {
    expect(() => nodeCodecs.inflateConsumed(stream, payload.length - 1)).toThrow(CodecLimitError);
  });

  it('returns an exact-size buffer', () => {
    const small = nodeCodecs.inflateConsumed(deflateSync(Buffer.from('abc')), 100);
    expect(small.data.buffer.byteLength).toBe(small.data.length);
    expect(small.data.byteOffset).toBe(0);
  });

  it('accepts a zero limit for an empty stream', () => {
    const empty = deflateSync(Buffer.alloc(0));
    const r = nodeCodecs.inflateConsumed(Buffer.concat([empty, Buffer.from('xx')]), 0);
    expect(r.data.length).toBe(0);
    expect(r.consumed).toBe(empty.length);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects maxOutput %s with RangeError',
    (bad) => {
      expect(() => nodeCodecs.inflateConsumed(stream, bad)).toThrow(RangeError);
      expect(() => nodeCodecs.gunzip(bad)).toThrow(RangeError);
    },
  );

  it('throws CodecLimitError for a zero limit on non-empty output', () => {
    expect(() => nodeCodecs.inflateConsumed(stream, 0)).toThrow(CodecLimitError);
  });

  it('throws CodecTruncatedError when the stream is cut short', () => {
    expect(() => nodeCodecs.inflateConsumed(stream.subarray(0, stream.length - 3), 10_000)).toThrow(
      CodecTruncatedError,
    );
  });

  describe('with an expected size', () => {
    it('returns one exact-size buffer', () => {
      const r = nodeCodecs.inflateConsumed(stream, 10_000, payload.length);
      expect(Buffer.from(r.data)).toEqual(payload);
      expect(r.data.buffer.byteLength).toBe(payload.length);
      expect(r.data.byteOffset).toBe(0);
      expect(r.consumed).toBe(stream.length);
    });

    it('does not allocate a default 64 KB chunk', () => {
      const spy = vi.spyOn(Buffer, 'allocUnsafe');
      try {
        nodeCodecs.inflateConsumed(deflateSync(Buffer.from('abc')), 100, 3);
        expect(spy.mock.calls.every(([n]) => n < 65_536)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('throws CodecLimitError when the output is larger than expected', () => {
      expect(() => nodeCodecs.inflateConsumed(stream, 10_000, payload.length - 1)).toThrow(
        CodecLimitError,
      );
    });

    it('throws CodecCorruptError when the output is smaller than expected', () => {
      expect(() => nodeCodecs.inflateConsumed(stream, 10_000, payload.length + 1)).toThrow(
        CodecCorruptError,
      );
    });

    it('throws CodecLimitError when the expected size exceeds maxOutput', () => {
      expect(() => nodeCodecs.inflateConsumed(stream, 10, payload.length)).toThrow(CodecLimitError);
    });

    it('throws CodecLimitError for one output byte with expected size 0', () => {
      const oneByte = deflateSync(Buffer.from('x'));
      expect(() => nodeCodecs.inflateConsumed(oneByte, 100, 0)).toThrow(CodecLimitError);
    });

    it('accepts an empty stream with expected size 0 and maxOutput 0', () => {
      const empty = deflateSync(Buffer.alloc(0));
      expect(nodeCodecs.inflateConsumed(empty, 0, 0).data.length).toBe(0);
    });

    it.each([-1, 1.5, Number.NaN, 2 ** 53])('rejects expected size %s with RangeError', (bad) => {
      expect(() => nodeCodecs.inflateConsumed(stream, 10_000, bad)).toThrow(RangeError);
    });
  });

  it('throws CodecCorruptError for invalid data and for raw deflate', () => {
    expect(() => nodeCodecs.inflateConsumed(Buffer.from('zzzzzzzz'), 100)).toThrow(
      CodecCorruptError,
    );
    expect(() => nodeCodecs.inflateConsumed(deflateRawSync(payload), 10_000)).toThrow(
      CodecCorruptError,
    );
  });
});

describe('nodeCodecs gunzip', () => {
  it('joins concatenated members, however the input is chunked', async () => {
    const gz = Buffer.concat([gzipSync('ab'), gzipSync('cd')]);
    const chunks = Array.from(gz, (b) => Uint8Array.of(b));
    expect(Buffer.from(await run(nodeCodecs.gunzip(100), chunks)).toString()).toBe('abcd');
  });

  it('errors with CodecLimitError past maxOutput', async () => {
    const gz = gzipSync(Buffer.alloc(100_000));
    await expect(run(nodeCodecs.gunzip(1000), [gz])).rejects.toBeInstanceOf(CodecLimitError);
  });

  it('allows output exactly at the limit', async () => {
    const out = await run(nodeCodecs.gunzip(1000), [gzipSync(Buffer.alloc(1000))]);
    expect(out.length).toBe(1000);
  });

  it('errors with CodecTruncatedError when input ends inside a member', async () => {
    const gz = gzipSync('hello world');
    await expect(
      run(nodeCodecs.gunzip(100), [gz.subarray(0, gz.length - 4)]),
    ).rejects.toBeInstanceOf(CodecTruncatedError);
  });

  it('errors with CodecCorruptError for bad header and trailing junk', async () => {
    await expect(
      run(nodeCodecs.gunzip(100), [Buffer.from('not gzip data')]),
    ).rejects.toBeInstanceOf(CodecCorruptError);
    await expect(
      run(nodeCodecs.gunzip(100), [Buffer.concat([gzipSync('ab'), Buffer.from('junk')])]),
    ).rejects.toBeInstanceOf(CodecCorruptError);
  });
});

describe('nodeCodecs gunzip streaming behaviour', () => {
  it('does not accumulate listeners over many drain waits', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      const gz = gzipSync(randomBytes(4 * 1024 * 1024));
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < gz.length; i += 65536) chunks.push(gz.subarray(i, i + 65536));
      const out = await run(nodeCodecs.gunzip(8 * 1024 * 1024), chunks);
      expect(out.length).toBe(4 * 1024 * 1024);
      await new Promise((r) => setImmediate(r));
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('surfaces the limit error on the reader while upstream stalls', async () => {
    const t = nodeCodecs.gunzip(1000);
    const writer = t.writable.getWriter();
    void writer.write(gzipSync(Buffer.alloc(100_000))).catch(() => undefined);
    const reader = t.readable.getReader();
    const outcome = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return 'done';
      })().catch((e: unknown) => e),
      new Promise((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    expect(outcome).toBeInstanceOf(CodecLimitError);
  });

  it('surfaces corrupt input without further input', async () => {
    const t = nodeCodecs.gunzip(1000);
    const writer = t.writable.getWriter();
    void writer.write(Buffer.from('this is not gzip at all')).catch(() => undefined);
    await expect(t.readable.getReader().read()).rejects.toBeInstanceOf(CodecCorruptError);
  });

  it('keeps queued output bounded to a chunk window until the reader pulls', async () => {
    const t = nodeCodecs.gunzip(1024 * 1024);
    const writer = t.writable.getWriter();
    void writer.write(gzipSync(Buffer.alloc(32 * 1024 * 1024))).catch(() => undefined);
    const closed = writer.closed.then(
      () => 'closed',
      (e: unknown) => e,
    );
    const early = await Promise.race([
      closed,
      new Promise((r) => setTimeout(() => r('quiet'), 100)),
    ]);
    expect(early).toBe('quiet');
    const reader = t.readable.getReader();
    let total = 0;
    await expect(
      (async () => {
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          total += r.value.length;
        }
      })(),
    ).rejects.toBeInstanceOf(CodecLimitError);
    expect(total).toBeLessThanOrEqual(1024 * 1024);
  });

  it('copies output off the engine buffer', async () => {
    const out = await run(nodeCodecs.gunzip(100), [gzipSync('ab')]);
    expect(out.buffer.byteLength).toBe(out.length);
  });

  it('rejects zero padding after a member as corrupt', async () => {
    await expect(
      run(nodeCodecs.gunzip(100), [Buffer.concat([gzipSync('ab'), Buffer.alloc(3)])]),
    ).rejects.toBeInstanceOf(CodecCorruptError);
  });

  it('treats empty input as truncated', async () => {
    await expect(run(nodeCodecs.gunzip(100), [])).rejects.toBeInstanceOf(CodecTruncatedError);
  });
});

describe('nodeCodecs deflateRaw', () => {
  it('produces a raw deflate stream that inflates back', async () => {
    const out = await run(nodeCodecs.deflateRaw(), [message.subarray(0, 30), message.subarray(30)]);
    expect(new Uint8Array(inflateRawSync(out))).toEqual(message);
  });
});

describe('nodeCodecs deflateRaw errors', () => {
  it('labels an engine failure as deflate', async () => {
    swap.deflateRawAsGunzip = true;
    try {
      const failure = await run(nodeCodecs.deflateRaw(), [Buffer.from('zzzzzzzzzz')]).catch(
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(CodecCorruptError);
      expect((failure as CodecCorruptError).operation).toBe('deflate');
    } finally {
      swap.deflateRawAsGunzip = false;
    }
  });
});
