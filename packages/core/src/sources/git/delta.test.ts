import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type Codecs,
  type DigestAlgorithm,
} from '../../platform/codec.js';
import { DeltaError, MAX_DELTA_CHAIN_DEPTH, resolvePackObjects } from './delta.js';
import { PackBudget, PackBudgetError, type PackObject, parsePackObjects } from './pack.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const codecs: Codecs = {
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

const limits = { maxObjects: 50_000, maxRetainedBytes: 1 << 20, maxObjectBytes: 1 << 16 };
const newBudget = (over: Partial<typeof limits> = {}) => new PackBudget({ ...limits, ...over });

const gitId = (type: string, data: Uint8Array): string =>
  createHash('sha1')
    .update(enc.encode(`${type} ${data.length}\0`))
    .update(data)
    .digest('hex');

function sizeVarint(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  while (rest >= 128) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function copyOp(offset: number, size: number): number[] {
  const bytes: number[] = [];
  let op = 0x80;
  for (let i = 0; i < 4; i++) {
    const b = Math.floor(offset / 2 ** (8 * i)) & 0xff;
    if (b) {
      op |= 1 << i;
      bytes.push(b);
    }
  }
  for (let i = 0; i < 3; i++) {
    const b = (size >> (8 * i)) & 0xff;
    if (b) {
      op |= 0x10 << i;
      bytes.push(b);
    }
  }
  return [op, ...bytes];
}

function delta(baseSize: number, resultSize: number, ops: number[]): Uint8Array {
  return Uint8Array.from([...sizeVarint(baseSize), ...sizeVarint(resultSize), ...ops]);
}

const insertOp = (text: string): number[] => [text.length, ...enc.encode(text)];

const base = (offset: number, data: Uint8Array): PackObject => ({
  kind: 'base',
  offset,
  type: 'blob',
  data,
});

describe('resolvePackObjects', () => {
  const baseData = enc.encode('0123456789');

  it('applies an OFS delta mixing copy and insert and recomputes the id', async () => {
    const d = delta(10, 8, [...copyOp(2, 4), ...insertOp('wxyz')]);
    const { objects } = await resolvePackObjects(
      {
        version: 2,
        objects: [base(12, baseData), { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d }],
      },
      codecs,
      newBudget(),
    );
    expect(objects).toHaveLength(2);
    const out = objects[1];
    expect(out?.type).toBe('blob');
    expect(dec.decode(out?.data)).toBe('2345wxyz');
    expect(out?.oid).toBe(gitId('blob', enc.encode('2345wxyz')));
  });

  it('treats a copy size of zero as 0x10000', async () => {
    const big = new Uint8Array(0x10000).fill(7);
    const d = delta(big.length, 0x10000, [0x80]);
    const { objects } = await resolvePackObjects(
      {
        version: 2,
        objects: [base(12, big), { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d }],
      },
      codecs,
      newBudget({ maxObjectBytes: 1 << 17 }),
    );
    expect(objects[1]?.data.length).toBe(0x10000);
  });

  it('resolves a REF delta only through a verified object id', async () => {
    const baseId = gitId('blob', baseData);
    const d = delta(10, 3, copyOp(0, 3));
    const { objects } = await resolvePackObjects(
      {
        version: 2,
        objects: [{ kind: 'ref-delta', offset: 12, baseOid: baseId, delta: d }, base(80, baseData)],
      },
      codecs,
      newBudget(),
    );
    expect(dec.decode(objects[0]?.data)).toBe('012');
  });

  it('refuses a REF delta whose base id is not in the pack', async () => {
    const d = delta(10, 3, copyOp(0, 3));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ref-delta', offset: 40, baseOid: 'ab'.repeat(20), delta: d },
          ],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'missing_base' });
  });

  it('refuses reference cycles between REF deltas', async () => {
    const d = delta(10, 10, copyOp(0, 10));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            { kind: 'ref-delta', offset: 12, baseOid: 'aa'.repeat(20), delta: d },
            { kind: 'ref-delta', offset: 50, baseOid: 'bb'.repeat(20), delta: d },
          ],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'missing_base' });
  });

  it('refuses a copy that reads past the end of the base', async () => {
    const d = delta(10, 6, copyOp(8, 6));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
          ],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ name: 'DeltaError', code: 'copy_out_of_range' });
  });

  it('refuses a copy whose offset alone is outside the base', async () => {
    const d = delta(10, 1, copyOp(2 ** 31, 1));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
          ],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'copy_out_of_range' });
  });

  it('refuses a delta whose declared base size differs from the base', async () => {
    const d = delta(11, 3, copyOp(0, 3));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
          ],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'base_size_mismatch' });
  });

  it('refuses a result shorter or longer than the declared size', async () => {
    for (const declared of [5, 2]) {
      const d = delta(10, declared, copyOp(0, 3));
      await expect(
        resolvePackObjects(
          {
            version: 2,
            objects: [
              base(12, baseData),
              { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
            ],
          },
          codecs,
          newBudget(),
        ),
      ).rejects.toMatchObject({ code: 'result_size_mismatch' });
    }
  });

  it('refuses opcode 0 and truncated instructions', async () => {
    const cases: [Uint8Array, string][] = [
      [delta(10, 1, [0]), 'bad_opcode'],
      [delta(10, 5, [5, 1, 2]), 'truncated_delta'],
      [delta(10, 3, [0x81]), 'truncated_delta'],
      [Uint8Array.of(0x80), 'truncated_delta'],
    ];
    for (const [d, code] of cases) {
      await expect(
        resolvePackObjects(
          {
            version: 2,
            objects: [
              base(12, baseData),
              { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
            ],
          },
          codecs,
          newBudget(),
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('charges the result to the budget before allocating it', async () => {
    const d = delta(10, 40_000, [...copyOp(0, 10)]);
    const budget = newBudget({ maxRetainedBytes: 1000 });
    budget.charge(10 + d.length);
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
          ],
        },
        codecs,
        budget,
      ),
    ).rejects.toBeInstanceOf(PackBudgetError);
    expect(budget.retainedBytes).toBeLessThan(1000);
  });

  it('refuses a result above the per-object cap', async () => {
    const d = delta(10, 5000, copyOp(0, 10));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
          ],
        },
        codecs,
        newBudget({ maxObjectBytes: 4000 }),
      ),
    ).rejects.toMatchObject({ code: 'object_bytes' });
  });

  function chain(length: number): PackObject[] {
    const objects: PackObject[] = [base(12, baseData)];
    for (let i = 1; i <= length; i++) {
      objects.push({
        kind: 'ofs-delta',
        offset: 12 + i * 10,
        baseOffset: 12 + (i - 1) * 10,
        delta: delta(10, 10, copyOp(0, 10)),
      });
    }
    return objects;
  }

  it('accepts a chain of depth 50 and refuses depth 51', async () => {
    expect(MAX_DELTA_CHAIN_DEPTH).toBe(50);
    const ok = await resolvePackObjects({ version: 2, objects: chain(50) }, codecs, newBudget());
    expect(ok.objects).toHaveLength(51);
    await expect(
      resolvePackObjects({ version: 2, objects: chain(51) }, codecs, newBudget()),
    ).rejects.toMatchObject({ code: 'chain_too_deep' });
  });

  it('counts REF delta links toward the chain depth', async () => {
    const objects: PackObject[] = [];
    let prev = baseData;
    objects.push(base(12, prev));
    for (let i = 1; i <= 51; i++) {
      objects.push({
        kind: 'ref-delta',
        offset: 12 + i * 30,
        baseOid: gitId('blob', prev),
        delta: delta(prev.length, prev.length + 1, [...copyOp(0, prev.length), ...insertOp('x')]),
      });
      prev = enc.encode(`${dec.decode(prev)}x`);
    }
    await expect(
      resolvePackObjects({ version: 2, objects }, codecs, newBudget()),
    ).rejects.toMatchObject({ code: 'chain_too_deep' });
  });

  it('resolves many REF deltas waiting on one base without spreading them', async () => {
    const d = delta(10, 1, copyOp(0, 1));
    const objects: PackObject[] = [];
    for (let i = 0; i < 150_000; i++) {
      objects.push({
        kind: 'ref-delta',
        offset: 12 + i,
        baseOid: gitId('blob', baseData),
        delta: d,
      });
    }
    objects.push(base(12 + 150_000, baseData));
    const { objects: out } = await resolvePackObjects(
      { version: 2, objects },
      codecs,
      newBudget({ maxRetainedBytes: 1 << 22 }),
    );
    expect(out).toHaveLength(150_001);
    expect(dec.decode(out[0]?.data)).toBe('0');
  });

  it('resolves an OFS delta on a REF delta result and a REF delta on an OFS result', async () => {
    const mid = enc.encode('2345wxyz');
    const midId = gitId('blob', mid);
    const refOnBase = delta(10, 8, [...copyOp(2, 4), ...insertOp('wxyz')]);
    const ofsOnRef = delta(8, 4, copyOp(4, 4));
    const refOnOfs = delta(4, 2, copyOp(1, 2));
    const { objects } = await resolvePackObjects(
      {
        version: 2,
        objects: [
          base(12, baseData),
          { kind: 'ref-delta', offset: 40, baseOid: gitId('blob', baseData), delta: refOnBase },
          { kind: 'ofs-delta', offset: 80, baseOffset: 40, delta: ofsOnRef },
          {
            kind: 'ref-delta',
            offset: 120,
            baseOid: gitId('blob', enc.encode('wxyz')),
            delta: refOnOfs,
          },
        ],
      },
      codecs,
      newBudget(),
    );
    expect(objects[1]?.oid).toBe(midId);
    expect(dec.decode(objects[2]?.data)).toBe('wxyz');
    expect(dec.decode(objects[3]?.data)).toBe('xy');
  });

  it('resolves a REF delta whose base appears later as an OFS delta result', async () => {
    const d1 = delta(10, 4, copyOp(0, 4));
    const d2 = delta(4, 2, copyOp(0, 2));
    const { objects } = await resolvePackObjects(
      {
        version: 2,
        objects: [
          { kind: 'ref-delta', offset: 12, baseOid: gitId('blob', enc.encode('0123')), delta: d2 },
          base(40, baseData),
          { kind: 'ofs-delta', offset: 80, baseOffset: 40, delta: d1 },
        ],
      },
      codecs,
      newBudget(),
    );
    expect(dec.decode(objects[0]?.data)).toBe('01');
  });

  it('gives a delta the type of its base', async () => {
    const treeBase: PackObject = { kind: 'base', offset: 12, type: 'tree', data: baseData };
    const { objects } = await resolvePackObjects(
      {
        version: 2,
        objects: [
          treeBase,
          { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: delta(10, 3, copyOp(0, 3)) },
        ],
      },
      codecs,
      newBudget(),
    );
    expect(objects[1]?.type).toBe('tree');
    expect(objects[1]?.oid).toBe(gitId('tree', enc.encode('012')));
  });

  it('accepts a REF chain of exactly 50', async () => {
    const objects: PackObject[] = [base(12, baseData)];
    let prev = baseData;
    for (let i = 1; i <= 50; i++) {
      objects.push({
        kind: 'ref-delta',
        offset: 12 + i * 30,
        baseOid: gitId('blob', prev),
        delta: delta(prev.length, prev.length + 1, [...copyOp(0, prev.length), ...insertOp('x')]),
      });
      prev = enc.encode(`${dec.decode(prev)}x`);
    }
    const out = await resolvePackObjects({ version: 2, objects }, codecs, newBudget());
    expect(out.objects).toHaveLength(51);
  });

  it('refuses a REF delta that names its own result as its base', async () => {
    const result = enc.encode('abc');
    const d = delta(3, 3, insertOp('abc'));
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [{ kind: 'ref-delta', offset: 12, baseOid: gitId('blob', result), delta: d }],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'missing_base' });
  });

  it('refuses an over-long size varint', async () => {
    const d = Uint8Array.from([...Array(9).fill(0x80), 0x01]);
    await expect(
      resolvePackObjects(
        {
          version: 2,
          objects: [
            base(12, baseData),
            { kind: 'ofs-delta', offset: 40, baseOffset: 12, delta: d },
          ],
        },
        codecs,
        newBudget(),
      ),
    ).rejects.toMatchObject({ code: 'bad_size' });
  });

  it('exposes DeltaError as an Error', () => {
    expect(new DeltaError('bad_opcode')).toBeInstanceOf(Error);
  });
});

describe('resolvePackObjects with git packs', () => {
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

  async function resolveFixture(name: string) {
    const raw = await parsePackObjects(fixture(name), codecs, newBudget());
    return { raw, resolved: await resolvePackObjects(raw, codecs, newBudget()) };
  }

  it('returns objects whose ids equal the SHA-1 of their canonical form', async () => {
    for (const name of ['ofs-delta.pack', 'ref-delta.pack']) {
      const { raw, resolved } = await resolveFixture(name);
      expect(resolved.objects).toHaveLength(raw.objects.length);
      for (const o of resolved.objects) expect(o.oid).toBe(gitId(o.type, o.data));
    }
  });

  it('resolves deltas in both fixtures to the same object set, and the tree names every blob', async () => {
    const ofs = await resolveFixture('ofs-delta.pack');
    const ref = await resolveFixture('ref-delta.pack');
    expect(ofs.raw.objects.some((o) => o.kind === 'ofs-delta')).toBe(true);
    expect(ref.raw.objects.some((o) => o.kind === 'ref-delta')).toBe(true);
    const ids = (r: typeof ofs) => r.resolved.objects.map((o) => o.oid).sort();
    expect(ids(ofs)).toEqual(ids(ref));

    const ofsIds = new Set(ids(ofs));
    const tree = ofs.resolved.objects.find((o) => o.type === 'tree');
    expect(tree).toBeDefined();
    const named: string[] = [];
    const data = tree?.data ?? new Uint8Array(0);
    let p = 0;
    while (p < data.length) {
      while (data[p] !== 0) p++;
      p++;
      named.push(
        Array.from(data.subarray(p, p + 20), (b) => b.toString(16).padStart(2, '0')).join(''),
      );
      p += 20;
    }
    expect(named).toHaveLength(4);
    for (const id of named) expect(ofsIds.has(id)).toBe(true);
  });

  it('pins the git-verified object ids of both fixtures', async () => {
    const expected = [
      '584f15da05d8f26250d101285ac0a39f189f1318',
      '6bd3c7d3f438a03ebb037008e29513448a147e5f',
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      'e9701ccb20d72aa8241d5a58f9b72dbc7a127084',
      'ff4e47555144f72d5d4294ab8a00bc782c073c5f',
    ];
    for (const name of ['ofs-delta.pack', 'ref-delta.pack']) {
      const { resolved } = await resolveFixture(name);
      expect(resolved.objects.map((o) => o.oid).sort()).toEqual(expected);
    }
  });

  it('refuses a delta result that exceeds the allowance left after parsing on a shared budget', async () => {
    const probe = newBudget();
    await parsePackObjects(fixture('ofs-delta.pack'), codecs, probe);
    const budget = newBudget({ maxRetainedBytes: probe.retainedBytes + 10 });
    const raw = await parsePackObjects(fixture('ofs-delta.pack'), codecs, budget);
    await expect(resolvePackObjects(raw, codecs, budget)).rejects.toBeInstanceOf(PackBudgetError);
  });
});
