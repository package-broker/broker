import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const MIB = 1024 * 1024;
const CLOUDFLARE_LIMITS = {
  packBytes: 16 * MIB,
  maxRetainedBytes: 24 * MIB,
  maxObjects: 50_000,
  maxObjectBytes: 8 * MIB,
} as const;

const read = (relative: string): string =>
  stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const codecAdapter = read('./codec/workers-codec.ts').replaceAll(
  "'@package-broker/core/platform/codec'",
  "'./codec-core.mjs'",
);
const codecCore = read('../../core/src/platform/codec.ts');
const pack = read('../../core/src/sources/git/pack.ts').replaceAll(
  "'../../platform/codec.js'",
  "'./codec-core.mjs'",
);
const delta = read('../../core/src/sources/git/delta.ts');

for (const [name, source] of [
  ['codec core', codecCore],
  ['pack', pack],
  ['delta', delta],
] as const) {
  if (/^\s*(import|export)\b[^;]*\sfrom\s+'\.\.?\/[^']*\.js'/m.test(source)) {
    throw new Error(`${name} gained a runtime relative import; load it as a module here too`);
  }
}

const WORKER = `
import { workersCodecs } from './workers-codec.mjs';
import { PackBudget, parsePackObjects } from './pack.mjs';
import { resolvePackObjects } from './delta.mjs';

export default {
  async fetch(request) {
    const limits = JSON.parse(request.headers.get('x-limits'));
    const bytes = new Uint8Array(await request.arrayBuffer());
    const budget = new PackBudget(limits);
    try {
      const parsed = await parsePackObjects(bytes, workersCodecs, budget);
      const resolved = await resolvePackObjects(parsed, workersCodecs, budget);
      return Response.json({
        objects: resolved.objects.length,
        retained: budget.retainedBytes,
      });
    } catch (e) {
      return Response.json({ error: e?.name ?? 'Error', code: e?.code ?? null });
    }
  },
};
`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: WORKER },
      { type: 'ESModule', path: 'workers-codec.mjs', contents: codecAdapter },
      { type: 'ESModule', path: 'codec-core.mjs', contents: codecCore },
      { type: 'ESModule', path: 'pack.mjs', contents: pack },
      { type: 'ESModule', path: 'delta.mjs', contents: delta },
    ],
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
  } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

function fullCopyDelta(size: number): Uint8Array {
  const sizeBytes = [size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff];
  const flags = sizeBytes.reduce((op, b, i) => (b ? op | (0x10 << i) : op), 0x80);
  return Uint8Array.from([
    ...sizeVarint(size),
    ...sizeVarint(size),
    flags,
    ...sizeBytes.filter((b) => b),
  ]);
}

interface PackEntry {
  readonly data: Uint8Array;
  readonly ofsBase?: number;
}

function buildPack(entries: readonly PackEntry[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('PACK'));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, entries.length);
  const parts: Uint8Array[] = [header];
  const starts: number[] = [];
  let at = header.length;
  for (const e of entries) {
    starts.push(at);
    const piece =
      e.ofsBase === undefined
        ? [objectHeader(3, e.data.length)]
        : [objectHeader(6, e.data.length), ofsVarint(at - (starts[e.ofsBase] as number))];
    piece.push(new Uint8Array(deflateSync(e.data, { level: 0 })));
    const bytes = concat(piece);
    parts.push(bytes);
    at += bytes.length;
  }
  const body = concat(parts);
  return concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
}

interface Outcome {
  objects?: number;
  retained?: number;
  error?: string;
  code?: string | null;
}

async function run(bytes: Uint8Array): Promise<Outcome> {
  const response = await mf.dispatchFetch('http://pack.test/', {
    method: 'POST',
    headers: { 'x-limits': JSON.stringify({ ...CLOUDFLARE_LIMITS }) },
    body: bytes,
  });
  return (await response.json()) as Outcome;
}

const STORED_EMPTY_BLOCK = Uint8Array.of(0, 0, 0, 0xff, 0xff);

function paddedPack(objectBytes: number, packBytes: number): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('PACK'));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, 1);
  const stream = new Uint8Array(deflateSync(randomBytes(objectBytes), { level: 0 }));
  const prefix = concat([header, objectHeader(3, objectBytes)]);
  const free = packBytes - prefix.length - stream.length - 20;
  if (free < 0 || free % STORED_EMPTY_BLOCK.length !== 0) {
    throw new Error('pack size is not reachable with empty stored blocks');
  }
  const padding = concat(
    Array.from({ length: free / STORED_EMPTY_BLOCK.length }, () => STORED_EMPTY_BLOCK),
  );
  const body = concat([prefix, stream.subarray(0, 2), padding, stream.subarray(2)]);
  return concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
}

function packLengthFor(objectBytes: number, atMost: number): number {
  const fixed =
    12 +
    objectHeader(3, objectBytes).length +
    deflateSync(new Uint8Array(objectBytes), { level: 0 }).length +
    20;
  return atMost - ((atMost - fixed) % STORED_EMPTY_BLOCK.length);
}

const random = (size: number): Uint8Array => new Uint8Array(randomBytes(size));

describe('pack budget under the Workers limits', () => {
  it('parses the largest incompressible pack the retained budget admits', async () => {
    const each = 6 * MIB - 32 * 1024;
    const bytes = buildPack([{ data: random(each) }, { data: random(each) }]);
    expect(bytes.length).toBeLessThan(CLOUDFLARE_LIMITS.packBytes);
    expect(each).toBeLessThan(CLOUDFLARE_LIMITS.maxObjectBytes);
    const outcome = await run(bytes);
    expect(outcome).toMatchObject({ objects: 2 });
    expect(outcome.retained).toBeGreaterThan(CLOUDFLARE_LIMITS.maxRetainedBytes - 256 * 1024);
    expect(outcome.retained).toBeLessThanOrEqual(CLOUDFLARE_LIMITS.maxRetainedBytes);
  }, 60_000);

  it('refuses an incompressible pack that one more object pushes past the retained budget', async () => {
    const each = 6 * MIB + 32 * 1024;
    const bytes = buildPack([{ data: random(each) }, { data: random(each) }]);
    expect(await run(bytes)).toEqual({ error: 'PackBudgetError', code: 'retained_bytes' });
  }, 60_000);

  describe('pack size cap', () => {
    const OBJECT = CLOUDFLARE_LIMITS.maxObjectBytes;
    const atCap = packLengthFor(OBJECT, CLOUDFLARE_LIMITS.packBytes);

    it('parses a pack just below the 16 MiB cap next to a maximum-size object', async () => {
      const bytes = paddedPack(OBJECT, atCap);
      expect(bytes.length).toBeLessThanOrEqual(CLOUDFLARE_LIMITS.packBytes);
      expect(CLOUDFLARE_LIMITS.packBytes - bytes.length).toBeLessThan(STORED_EMPTY_BLOCK.length);
      expect(await run(bytes)).toEqual({ objects: 1, retained: bytes.length + OBJECT });
    }, 60_000);

    it('refuses a pack just above the 16 MiB cap, which the 24 MiB retained budget maps to too_large', async () => {
      const bytes = paddedPack(OBJECT, atCap + STORED_EMPTY_BLOCK.length);
      expect(bytes.length).toBeGreaterThan(CLOUDFLARE_LIMITS.packBytes);
      expect(bytes.length - CLOUDFLARE_LIMITS.packBytes).toBeLessThanOrEqual(
        STORED_EMPTY_BLOCK.length,
      );
      expect(await run(bytes)).toEqual({ error: 'PackBudgetError', code: 'retained_bytes' });
    }, 60_000);
  });

  describe('delta outputs', () => {
    const OBJECT = 4 * MIB;
    const withCopies = (copies: number): Uint8Array =>
      buildPack([
        { data: random(OBJECT) },
        ...Array.from({ length: copies }, () => ({ data: fullCopyDelta(OBJECT), ofsBase: 0 })),
      ]);

    it('resolves a few copies whose total stays inside the budget', async () => {
      expect(await run(withCopies(2))).toMatchObject({ objects: 3 });
    }, 60_000);

    it('refuses copies that together cross maxRetainedBytes though each is under the object cap', async () => {
      expect(OBJECT).toBeLessThan(CLOUDFLARE_LIMITS.maxObjectBytes);
      expect(await run(withCopies(6))).toEqual({
        error: 'PackBudgetError',
        code: 'retained_bytes',
      });
    }, 60_000);
  });
});
