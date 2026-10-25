import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type Codecs,
  type DigestAlgorithm,
} from '../../platform/codec.js';
import { PackBudget, PackBudgetError, PackFormatError, parsePackObjects } from './pack.js';

const enc = new TextEncoder();

function makeCodecs(onInflate?: (maxOutput: number) => void): Codecs {
  return {
    digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
      const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
      let resolveDigests!: (v: Record<A, Uint8Array>) => void;
      const digests = new Promise<Record<A, Uint8Array>>((resolve) => {
        resolveDigests = resolve;
      });
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const [, h] of hashes) h.update(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          resolveDigests(
            Object.fromEntries(hashes.map(([a, h]) => [a, new Uint8Array(h.digest())])) as Record<
              A,
              Uint8Array
            >,
          );
        },
      });
      return { transform, digests };
    },
    inflateConsumed(input, maxOutput) {
      onInflate?.(maxOutput);
      try {
        const { buffer, engine } = inflateSync(input, {
          info: true,
          maxOutputLength: maxOutput + 1,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (buffer.length > maxOutput) throw new CodecLimitError('inflate', maxOutput);
        return { data: new Uint8Array(buffer), consumed: engine.bytesWritten };
      } catch (e) {
        if (e instanceof CodecLimitError) throw e;
        const code = (e as { code?: string }).code;
        if (code === 'ERR_BUFFER_TOO_LARGE') throw new CodecLimitError('inflate', maxOutput);
        if (code === 'Z_BUF_ERROR') throw new CodecTruncatedError('inflate');
        throw new CodecCorruptError('inflate');
      }
    },
    gunzip: () => {
      throw new Error('unused');
    },
    deflateRaw: () => {
      throw new Error('unused');
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Uint8Array.from(bytes);
}

function ofsVarint(distance: number): Uint8Array {
  const bytes = [distance & 0x7f];
  let d = Math.floor(distance / 128);
  while (d > 0) {
    d -= 1;
    bytes.unshift(0x80 | (d & 0x7f));
    d = Math.floor(d / 128);
  }
  return Uint8Array.from(bytes);
}

interface Entry {
  type: number;
  payload: Uint8Array;
  declaredSize?: number;
  prefix?: Uint8Array;
}

function buildPack(entries: Entry[], opts: { count?: number; version?: number } = {}): Uint8Array {
  const header = new Uint8Array(12);
  header.set(enc.encode('PACK'));
  const dv = new DataView(header.buffer);
  dv.setUint32(4, opts.version ?? 2);
  dv.setUint32(8, opts.count ?? entries.length);
  const parts: Uint8Array[] = [header];
  for (const e of entries) {
    parts.push(objectHeader(e.type, e.declaredSize ?? e.payload.length));
    if (e.prefix) parts.push(e.prefix);
    parts.push(new Uint8Array(deflateSync(e.payload)));
  }
  const body = concat(parts);
  return concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
}

const limits = { maxObjects: 50_000, maxRetainedBytes: 1 << 20, maxObjectBytes: 1 << 16 };
const newBudget = (over: Partial<typeof limits> = {}) => new PackBudget({ ...limits, ...over });

describe('parsePackObjects', () => {
  it('returns base objects with their types', async () => {
    const pack = buildPack([
      { type: 3, payload: enc.encode('hello blob') },
      { type: 1, payload: enc.encode('tree 0000\n\nmsg') },
      { type: 0b100, payload: new Uint8Array(0) },
    ]);
    const { objects } = await parsePackObjects(pack, makeCodecs(), newBudget());
    expect(objects.map((o) => o.kind)).toEqual(['base', 'base', 'base']);
    expect(objects[0]).toMatchObject({ kind: 'base', type: 'blob' });
    expect(objects[1]).toMatchObject({ kind: 'base', type: 'commit' });
    expect(objects[2]).toMatchObject({ kind: 'base', type: 'tag' });
    expect(objects[0]?.kind === 'base' && new TextDecoder().decode(objects[0].data)).toBe(
      'hello blob',
    );
  });

  it('returns ofs-delta and ref-delta objects unresolved', async () => {
    const first = buildPack([{ type: 3, payload: enc.encode('base') }]);
    const firstObjectLength = first.length - 12 - 20;
    const baseOid = new Uint8Array(20).fill(0xab);
    const pack = buildPack([
      { type: 3, payload: enc.encode('base') },
      { type: 6, payload: Uint8Array.of(4, 4), prefix: ofsVarint(firstObjectLength) },
      { type: 7, payload: Uint8Array.of(4, 4), prefix: baseOid },
    ]);
    const { objects } = await parsePackObjects(pack, makeCodecs(), newBudget());
    expect(objects[1]).toMatchObject({ kind: 'ofs-delta', baseOffset: 12 });
    expect(objects[2]).toMatchObject({ kind: 'ref-delta', baseOid: 'ab'.repeat(20) });
    expect(objects[1]?.offset).toBe(12 + firstObjectLength);
  });

  const fixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

  it('parses a git pack with OFS deltas and resolves their base offsets to earlier objects', async () => {
    const { objects } = await parsePackObjects(
      fixture('ofs-delta.pack'),
      makeCodecs(),
      newBudget(),
    );
    expect(objects.length).toBe(5);
    const deltas = objects.filter((o) => o.kind === 'ofs-delta');
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      if (d.kind !== 'ofs-delta') continue;
      const base = objects.find((o) => o.offset === d.baseOffset);
      expect(base).toBeDefined();
      expect(d.baseOffset).toBeLessThan(d.offset);
    }
  });

  it('parses a git pack with REF deltas', async () => {
    const { objects } = await parsePackObjects(
      fixture('ref-delta.pack'),
      makeCodecs(),
      newBudget(),
    );
    const refs = objects.filter((o) => o.kind === 'ref-delta');
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r.kind === 'ref-delta' && r.baseOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('parses a pack holding only an empty blob', async () => {
    const { objects } = await parsePackObjects(
      fixture('empty-blob.pack'),
      makeCodecs(),
      newBudget(),
    );
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ kind: 'base', type: 'blob' });
    expect(objects[0]?.kind === 'base' && objects[0].data.length).toBe(0);
  });

  it('refuses an ofs-delta whose base is inside an object, not at its start', async () => {
    const first = buildPack([{ type: 3, payload: enc.encode('base') }]);
    const firstObjectLength = first.length - 12 - 20;
    const pack = buildPack([
      { type: 3, payload: enc.encode('base') },
      { type: 6, payload: Uint8Array.of(4, 4), prefix: ofsVarint(firstObjectLength - 1) },
    ]);
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      code: 'bad_object_header',
    });
  });

  it('returns exact-size data when the codec output is a view over a larger buffer', async () => {
    const codecs = makeCodecs();
    const inner = codecs.inflateConsumed.bind(codecs);
    codecs.inflateConsumed = (input, max) => {
      const r = inner(input, max);
      const big = new Uint8Array(r.data.length + 64);
      big.set(r.data);
      return { data: big.subarray(0, r.data.length), consumed: r.consumed };
    };
    const { objects } = await parsePackObjects(
      buildPack([{ type: 3, payload: enc.encode('exact') }]),
      codecs,
      newBudget(),
    );
    const o = objects[0];
    expect(o?.kind === 'base' && o.data.buffer.byteLength).toBe(5);
  });

  it('refuses a corrupted trailer', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('x') }]);
    pack[pack.length - 1] = (pack[pack.length - 1] ?? 0) ^ 0xff;
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      name: 'PackFormatError',
      code: 'trailer_mismatch',
    });
  });

  it('refuses a body flipped under a stale trailer', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('payload') }]);
    pack[13] = (pack[13] ?? 0) ^ 0x01;
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toBeInstanceOf(
      PackFormatError,
    );
  });

  it('refuses a declared size smaller than the inflated size', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('0123456789'), declaredSize: 4 }]);
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      code: 'size_mismatch',
    });
  });

  it('refuses a declared size larger than the inflated size', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('0123'), declaredSize: 10 }]);
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      code: 'size_mismatch',
    });
  });

  it('refuses a bad signature, an unsupported version and an object count lie', async () => {
    const good = buildPack([{ type: 3, payload: enc.encode('x') }]);
    const badSig = good.slice();
    badSig[0] = 0x51;
    const resign = (p: Uint8Array) =>
      concat([
        p.subarray(0, p.length - 20),
        new Uint8Array(
          createHash('sha1')
            .update(p.subarray(0, p.length - 20))
            .digest(),
        ),
      ]);
    await expect(parsePackObjects(resign(badSig), makeCodecs(), newBudget())).rejects.toMatchObject(
      {
        code: 'bad_header',
      },
    );
    await expect(
      parsePackObjects(
        buildPack([{ type: 3, payload: enc.encode('x') }], { version: 4 }),
        makeCodecs(),
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'bad_header' });
    await expect(
      parsePackObjects(
        buildPack([{ type: 3, payload: enc.encode('x') }], { count: 2 }),
        makeCodecs(),
        newBudget(),
      ),
    ).rejects.toBeInstanceOf(PackFormatError);
    await expect(
      parsePackObjects(
        buildPack([{ type: 3, payload: enc.encode('x') }], { count: 0 }),
        makeCodecs(),
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'trailing_data' });
    await expect(
      parsePackObjects(good.subarray(0, 20), makeCodecs(), newBudget()),
    ).rejects.toMatchObject({ code: 'truncated' });
  });

  it('refuses an unbounded object header varint', async () => {
    const body = concat([
      enc.encode('PACK'),
      Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 1),
      Uint8Array.of(0xb0, ...new Array<number>(12).fill(0xff), 0x01),
      new Uint8Array(deflateSync(enc.encode('x'))),
    ]);
    const pack = concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      code: 'bad_object_header',
    });
  });

  it('refuses an ofs-delta pointing at or before the pack start', async () => {
    const pack = buildPack([{ type: 6, payload: Uint8Array.of(0, 0), prefix: ofsVarint(500) }]);
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      code: 'bad_object_header',
    });
  });

  it('refuses an object of an unknown type', async () => {
    const pack = buildPack([{ type: 5, payload: enc.encode('x') }]);
    await expect(parsePackObjects(pack, makeCodecs(), newBudget())).rejects.toMatchObject({
      code: 'bad_object_header',
    });
  });
});

describe('PackBudget', () => {
  it('charges the input buffer before parsing', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('x') }]);
    let inflated = 0;
    const codecs = makeCodecs(() => (inflated += 1));
    await expect(
      parsePackObjects(pack, codecs, newBudget({ maxRetainedBytes: pack.length - 1 })),
    ).rejects.toBeInstanceOf(PackBudgetError);
    expect(inflated).toBe(0);
  });

  it('charges the whole backing buffer when the pack is a view of a larger one', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('x') }]);
    const backing = new Uint8Array(10_000);
    backing.set(pack, 100);
    const view = backing.subarray(100, 100 + pack.length);
    await expect(
      parsePackObjects(view, makeCodecs(), newBudget({ maxRetainedBytes: pack.length + 500 })),
    ).rejects.toMatchObject({ code: 'retained_bytes' });
  });

  it('refuses before the inflate that would cross maxRetainedBytes', async () => {
    const a = new Uint8Array(1000).fill(1);
    const b = new Uint8Array(1000).fill(2);
    const pack = buildPack([
      { type: 3, payload: a },
      { type: 3, payload: b },
    ]);
    const calls: number[] = [];
    const codecs = makeCodecs((max) => calls.push(max));
    const budget = newBudget({ maxRetainedBytes: pack.length + 1500 });
    await expect(parsePackObjects(pack, codecs, budget)).rejects.toMatchObject({
      name: 'PackBudgetError',
      code: 'retained_bytes',
    });
    expect(calls).toEqual([1000]);
    expect(budget.retainedBytes).toBeLessThanOrEqual(pack.length + 1500);
  });

  it('refuses a declared size above maxObjectBytes without inflating', async () => {
    const pack = buildPack([{ type: 3, payload: enc.encode('tiny'), declaredSize: 1 << 30 }]);
    let inflated = 0;
    await expect(
      parsePackObjects(
        pack,
        makeCodecs(() => (inflated += 1)),
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'object_bytes' });
    expect(inflated).toBe(0);
  });

  it('refuses an object count above maxObjects from the header', async () => {
    const pack = buildPack([
      { type: 3, payload: enc.encode('a') },
      { type: 3, payload: enc.encode('b') },
    ]);
    let inflated = 0;
    await expect(
      parsePackObjects(
        pack,
        makeCodecs(() => (inflated += 1)),
        newBudget({ maxObjects: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'objects' });
    expect(inflated).toBe(0);
  });

  it('exposes charge for later delta outputs against the same budget', () => {
    const budget = newBudget({ maxRetainedBytes: 100 });
    budget.charge(60);
    expect(() => budget.charge(41)).toThrow(PackBudgetError);
    expect(budget.retainedBytes).toBe(60);
    budget.charge(40);
    expect(budget.retainedBytes).toBe(100);
  });

  it('rejects negative and fractional charges', () => {
    const budget = newBudget();
    expect(() => budget.charge(-1)).toThrow(RangeError);
    expect(() => budget.charge(1.5)).toThrow(RangeError);
  });

  it('returns released bytes to the budget once an object is done', () => {
    const budget = newBudget({ maxRetainedBytes: 100 });
    budget.chargeObject(80);
    expect(() => budget.charge(30)).toThrow(PackBudgetError);
    budget.release(80);
    expect(budget.retainedBytes).toBe(0);
    budget.charge(100);
    expect(budget.retainedBytes).toBe(100);
  });

  it('rejects negative, fractional and over-retained releases', () => {
    const budget = newBudget();
    budget.charge(10);
    expect(() => budget.release(-1)).toThrow(RangeError);
    expect(() => budget.release(1.5)).toThrow(RangeError);
    expect(() => budget.release(11)).toThrow(RangeError);
    expect(budget.retainedBytes).toBe(10);
  });
});
