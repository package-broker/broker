import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, Writable } from 'node:stream';
import { createDeflateRaw } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { buildZipFromTree, type ArchiveIo } from './archive.js';
import type { GitTree, GitTreeEntry } from './fetch.js';

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;

const codecs: Pick<Codecs, 'digestTap' | 'deflateRaw'> = {
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
  deflateRaw: () =>
    Duplex.toWeb(createDeflateRaw()) as unknown as TransformStream<Uint8Array, Uint8Array>,
};

function fill(seed: number, index: number, out: Uint8Array): void {
  let x = (seed * 2654435761 + index * 40503 + 1) | 1;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (x & 0x0f) + 0x41;
  }
}

function blobStream(seed: number, size: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const n = Math.min(CHUNK, size - index * CHUNK);
      if (n <= 0) return controller.close();
      const chunk = new Uint8Array(n);
      fill(seed, index++, chunk);
      controller.enqueue(chunk);
    },
  });
}

async function gitOid(seed: number, size: number): Promise<string> {
  const h = createHash('sha1').update(`blob ${size}\0`);
  for await (const chunk of blobStream(seed, size)) h.update(chunk);
  return h.digest('hex');
}

const used = (): number => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pb-archive-mem-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function peakAboveBaseline(blobs: { path: string; seed: number; size: number }[]) {
  const entries: GitTreeEntry[] = [];
  const seeds = new Map<string, { seed: number; size: number }>();
  for (const b of blobs) {
    const oid = await gitOid(b.seed, b.size);
    seeds.set(oid, b);
    entries.push({ path: b.path, mode: '100644', type: 'blob', oid });
  }
  const tree: GitTree = {
    commit: 'c'.repeat(40),
    committedAt: '2024-01-01T00:00:00Z',
    entries,
    skipped: 0,
  };
  let peak = 0;
  let writes = 0;
  const file = path.join(dir, 'out.zip');
  const sink = Writable.toWeb(createWriteStream(file)) as WritableStream<Uint8Array>;
  const sinkWriter = sink.getWriter();
  const io: ArchiveIo = {
    blobs: {
      read(oid) {
        const b = seeds.get(oid) as { seed: number; size: number };
        return Promise.resolve({ size: b.size, body: blobStream(b.seed, b.size) });
      },
    },
    staging: {
      create: () =>
        Promise.resolve({
          path: file,
          writable: new WritableStream<Uint8Array>({
            async write(chunk) {
              writes++;
              peak = Math.max(peak, used());
              await sinkWriter.write(chunk);
            },
            close: () => sinkWriter.close(),
            abort: (reason) => sinkWriter.abort(reason),
          }),
          discard: () => rm(file, { force: true }),
        }),
    },
  };
  const baseline = used();
  const result = await buildZipFromTree(tree, codecs, io);
  peak = Math.max(peak, used());
  expect(result.size).toBeGreaterThan(40 * MIB * 0.4);
  expect(writes).toBeGreaterThan(100);
  return peak - baseline;
}

describe('buildZipFromTree memory', () => {
  it('streams one 40 MiB blob with peak memory below 16 MiB above baseline', async () => {
    const delta = await peakAboveBaseline([{ path: 'data/big.bin', seed: 7, size: 40 * MIB }]);
    expect(delta).toBeLessThan(16 * MIB);
  });

  it('streams 40 blobs of 1 MiB with peak memory below 16 MiB above baseline', async () => {
    const blobs = Array.from({ length: 40 }, (_, i) => ({
      path: `data/f${String(i).padStart(2, '0')}.bin`,
      seed: i + 1,
      size: MIB,
    }));
    const delta = await peakAboveBaseline(blobs);
    expect(delta).toBeLessThan(16 * MIB);
  });
});
