import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  formatIntegrity,
  parseIntegrity,
  type Codecs,
  type DigestAlgorithm,
} from './codec.js';

function fakeCodecs(): Codecs {
  return {
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
            Object.fromEntries(
              hashes.map(([alg, h]) => [alg, new Uint8Array(h.digest())]),
            ) as never,
          );
        },
        cancel(reason) {
          settle.reject(reason);
        },
      });
      return { transform, digests };
    },
    inflateConsumed() {
      throw new CodecLimitError('inflate', 0);
    },
    gunzip: () => new TransformStream(),
    deflateRaw: () => new TransformStream(),
  };
}

const sha512Npm =
  'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==';
const sha256 = formatIntegrity('sha256', new Uint8Array(32).fill(1));
const sha384 = formatIntegrity('sha384', new Uint8Array(48).fill(2));

describe('codec port', () => {
  it('passes chunks through and resolves digests after close', async () => {
    const { transform, digests } = fakeCodecs().digestTap(['sha1', 'sha256']);
    const out = new Response(new Blob(['abc']).stream().pipeThrough(transform));
    expect(await out.text()).toBe('abc');
    const d = await digests;
    expect(Buffer.from(d.sha256!).toString('hex')).toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
    expect(Object.keys(d).sort()).toEqual(['sha1', 'sha256']);
  });

  it('does not settle digests before the writable closes', async () => {
    const { transform, digests } = fakeCodecs().digestTap(['sha256']);
    let settled = false;
    void digests.then(() => (settled = true));
    const writer = transform.writable.getWriter();
    const reading = transform.readable.getReader().read();
    await writer.write(new Uint8Array([1, 2]));
    await reading;
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    await writer.close();
    await digests;
    expect(settled).toBe(true);
  });

  it('rejects digests when the source errors', async () => {
    const { transform, digests } = fakeCodecs().digestTap(['sha256']);
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.error(new Error('boom'));
      },
    });
    const reader = source.pipeThrough(transform).getReader();
    await reader.read().catch(() => undefined);
    await reader.read().catch(() => undefined);
    await expect(digests).rejects.toThrow('boom');
  });

  it('rejects digests when the reader cancels', async () => {
    const { transform, digests } = fakeCodecs().digestTap(['sha256']);
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
    });
    const reader = source.pipeThrough(transform).getReader();
    await reader.read();
    await reader.cancel(new Error('stop'));
    await expect(digests).rejects.toThrow('stop');
  });

  it('types digests by the requested algorithms', async () => {
    const { digests } = fakeCodecs().digestTap(['sha512']);
    const probe: Promise<Uint8Array> = digests.then((d) => d.sha512);
    void probe.catch(() => undefined);
    expect(true).toBe(true);
  });

  it('resolves digests of an empty stream', async () => {
    const { transform, digests } = fakeCodecs().digestTap(['sha256']);
    await new Response(new Blob([]).stream().pipeThrough(transform)).arrayBuffer();
    expect(Buffer.from((await digests).sha256).toString('hex')).toBe(
      createHash('sha256').update('').digest('hex'),
    );
  });

  it('keeps typed errors distinguishable', () => {
    const t = new CodecTruncatedError('inflate');
    const c = new CodecCorruptError('gunzip');
    expect(t).toBeInstanceOf(Error);
    expect(t.name).toBe('CodecTruncatedError');
    expect(c.name).toBe('CodecCorruptError');
    expect(t).not.toBeInstanceOf(CodecCorruptError);
    expect(c.operation).toBe('gunzip');
  });

  it('exposes a typed limit error', () => {
    const e = new CodecLimitError('gunzip', 10);
    expect(e).toBeInstanceOf(Error);
    expect(e.maxOutput).toBe(10);
    expect(e.name).toBe('CodecLimitError');
  });
});

describe('codec port stream types', () => {
  it('accepts a TransformStream and a plain readable/writable pair', () => {
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const plain = { readable: transform.readable, writable: transform.writable };
    const withTransform: Codecs = {
      ...fakeCodecs(),
      gunzip: () => transform,
      deflateRaw: () => transform,
    };
    const withPlain: Codecs = { ...fakeCodecs(), gunzip: () => plain, deflateRaw: () => plain };
    expect(withTransform.gunzip(1)).toBe(transform);
    expect(withPlain.deflateRaw()).toBe(plain);
  });

  it('labels deflate failures', () => {
    const e = new CodecCorruptError('deflate');
    expect(e.operation).toBe('deflate');
    expect(new CodecLimitError('deflate', 3).message).toBe('deflate output exceeds 3 bytes');
  });
});

describe('parseIntegrity', () => {
  it('accepts an npm sha512 value', () => {
    const r = parseIntegrity(sha512Npm);
    expect(r?.strongestAlg).toBe('sha512');
    expect(r?.strongest[0]?.bytes.length).toBe(64);
    expect(r?.hashes).toHaveLength(1);
    expect(r?.rejectedTokens).toEqual([]);
  });

  it('accepts a sha1 value with padding', () => {
    const r = parseIntegrity(formatIntegrity('sha1', new Uint8Array(20).fill(7)));
    expect(r?.strongestAlg).toBe('sha1');
  });

  it('returns every valid hash and the strongest algorithm of a multi-hash string', () => {
    const r = parseIntegrity(`${sha256}  ${sha384}`);
    expect(r?.hashes.map((h) => h.alg)).toEqual(['sha256', 'sha384']);
    expect(r?.strongestAlg).toBe('sha384');
  });

  it('keeps all hashes of the strongest algorithm', () => {
    const other = formatIntegrity('sha512', new Uint8Array(64).fill(9));
    const r = parseIntegrity(`${sha256} ${sha512Npm} ${other}`);
    expect(r?.strongestAlg).toBe('sha512');
    expect(r?.strongest).toHaveLength(2);
    expect(r?.strongest.every((h) => h.alg === 'sha512')).toBe(true);
  });

  it('ignores unknown algorithms and options', () => {
    const r = parseIntegrity(`md5-AAAA ${sha256}?ct=application/octet-stream`);
    expect(r?.hashes.map((h) => h.alg)).toEqual(['sha256']);
    expect(r?.rejectedTokens).toEqual([]);
  });

  it('reports invalid tokens of a known algorithm', () => {
    const r = parseIntegrity(`sha512-AAAA ${sha256}`);
    expect(r?.strongestAlg).toBe('sha256');
    expect(r?.rejectedTokens).toEqual(['sha512-AAAA']);
  });

  it('treats algorithm names as case-sensitive', () => {
    expect(parseIntegrity(sha256.replace('sha256', 'SHA256'))).toBeNull();
  });

  it('splits on ASCII whitespace only', () => {
    expect(parseIntegrity(`${sha256}\t${sha384}\n`)?.hashes).toHaveLength(2);
    expect(parseIntegrity(`${sha256}\u00a0${sha384}`)).toBeNull();
  });

  it('refuses non-canonical base64', () => {
    const canonical = formatIntegrity('sha1', new Uint8Array(20));
    expect(parseIntegrity(canonical.replace('AAAA=', 'AAAB='))).toBeNull();
  });

  it('requires padding', () => {
    const noPad = formatIntegrity('sha1', new Uint8Array(20).fill(7)).replace(/=+$/, '');
    expect(parseIntegrity(noPad)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['wrong length', 'sha256-AAAA'],
    ['bad base64', `sha256-${'!'.repeat(44)}`],
    ['bad padding', `sha256-${'A'.repeat(43)}`],
    ['only unknown', 'md5-AAAAAAAAAAAAAAAAAAAAAA=='],
    ['no dash', 'sha256'],
  ])('refuses %s', (_n, value) => {
    expect(parseIntegrity(value)).toBeNull();
  });

  it('round-trips through formatIntegrity', () => {
    const bytes = new Uint8Array(32).map((_, i) => i);
    expect(parseIntegrity(formatIntegrity('sha256', bytes))?.strongest[0]?.bytes).toEqual(bytes);
  });

  it.each([
    ['sha384', 48],
    ['sha512', 64],
  ] as const)('round-trips %s through formatIntegrity', (alg, n) => {
    const bytes = new Uint8Array(n).map((_, i) => (i * 7) % 256);
    expect(parseIntegrity(formatIntegrity(alg, bytes))?.strongest[0]?.bytes).toEqual(bytes);
  });

  it('keeps duplicate tokens of the same algorithm', () => {
    const r = parseIntegrity(`${sha256} ${sha256}`);
    expect(r?.strongest).toHaveLength(2);
  });

  it('combines a valid hash with options and an invalid hash', () => {
    const r = parseIntegrity(`${sha384}?opt=1 sha512-AAAA`);
    expect(r?.strongestAlg).toBe('sha384');
    expect(r?.rejectedTokens).toEqual(['sha512-AAAA']);
  });

  it('formatIntegrity refuses a wrong digest length', () => {
    expect(() => formatIntegrity('sha256', new Uint8Array(31))).toThrow(RangeError);
  });
});
