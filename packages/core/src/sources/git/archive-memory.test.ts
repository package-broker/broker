import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createDeflateRaw } from 'node:zlib';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { buildZipFromTree, type ArchiveIo } from './archive.js';
import type { GitTree, GitTreeEntry } from './fetch.js';

const MIB = 1024 * 1024;
const PEAK_BOUND = 32 * MIB;
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

function blobFixture(seed: number, size: number) {
  const chunks: Uint8Array[] = [];
  const h = createHash('sha1').update(`blob ${size}\0`);
  for (let index = 0; index * CHUNK < size; index++) {
    const chunk = new Uint8Array(Math.min(CHUNK, size - index * CHUNK));
    fill(seed, index, chunk);
    chunks.push(chunk);
    h.update(chunk);
  }
  return { oid: h.digest('hex'), size, chunks };
}

function blobStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) return controller.close();
      controller.enqueue(chunks[index++] as Uint8Array);
    },
  });
}

// Buffer and Uint8Array backing stores count here, without unrelated JS heap garbage or RSS.
const used = (): number => process.memoryUsage().arrayBuffers;

async function stableBaseline(): Promise<number> {
  globalThis.gc?.();
  let baseline = used();
  for (let i = 0; i < 5; i++) {
    await setImmediate();
    baseline = Math.min(baseline, used());
  }
  return baseline;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pb-archive-mem-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function peakAboveBaseline(blobs: { path: string; seed: number; size: number }[]) {
  const entries: GitTreeEntry[] = [];
  const fixtures = new Map<string, ReturnType<typeof blobFixture>>();
  for (const b of blobs) {
    const fixture = blobFixture(b.seed, b.size);
    const { oid } = fixture;
    fixtures.set(oid, fixture);
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
        const b = fixtures.get(oid) as ReturnType<typeof blobFixture>;
        return Promise.resolve({ size: b.size, body: blobStream(b.chunks) });
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
  // Keep fixture backing stores alive throughout measurement; source generation is not archive memory.
  const baseline = await stableBaseline();
  const result = await buildZipFromTree(tree, codecs, io);
  peak = Math.max(peak, used());
  expect(result.size).toBeGreaterThan(40 * MIB * 0.4);
  expect(writes).toBeGreaterThan(100);
  return peak - baseline;
}

async function assertChunkRetention(buildArchive = buildZipFromTree): Promise<void> {
  const fixture = blobFixture(7, MIB);
  const refs: WeakRef<Uint8Array>[] = [];
  v8.setFlagsFromString('--expose-gc');
  const collectGarbage = vm.runInNewContext('gc') as () => void;
  let retained = 0;
  let sampled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === fixture.chunks.length) {
        // WeakRef targets survive their creating job; collect in a later event-loop turn.
        await setImmediate();
        collectGarbage();
        retained = refs.filter((ref) => ref.deref() !== undefined).length;
        sampled = true;
        controller.close();
        return;
      }
      // Fresh views share the preallocated bytes, but the fixture cannot retain the views.
      const chunk = (fixture.chunks[index++] as Uint8Array).subarray();
      refs.push(new WeakRef(chunk));
      controller.enqueue(chunk);
    },
  });
  await buildArchive(
    {
      commit: 'c'.repeat(40),
      committedAt: '2024-01-01T00:00:00Z',
      entries: [{ path: 'data/big.bin', mode: '100644', type: 'blob', oid: fixture.oid }],
      skipped: 0,
    },
    codecs,
    {
      blobs: { read: () => Promise.resolve({ size: fixture.size, body }) },
      staging: {
        create: () =>
          Promise.resolve({
            path: path.join(dir, 'retention.zip'),
            writable: new WritableStream<Uint8Array>(),
            discard: () => Promise.resolve(),
          }),
      },
    },
  );
  expect(sampled).toBe(true);
  expect(refs).toHaveLength(fixture.size / CHUNK);
  expect(retained, 'earlier source chunks must be released while streaming').toBeLessThan(
    fixture.chunks.length / 2,
  );
}

describe('buildZipFromTree memory', () => {
  it('releases source chunk references while streaming one 1 MiB blob', async () => {
    await assertChunkRetention();
  });

  it('rejects a stub that buffers all fixture-backed chunks before archiving', async () => {
    const bufferingArchive: typeof buildZipFromTree = (tree, codecs, io, options) =>
      buildZipFromTree(
        tree,
        codecs,
        {
          ...io,
          blobs: {
            async read(oid, maxBytes) {
              const { size, body } = await io.blobs.read(oid, maxBytes);
              const chunks: Uint8Array[] = [];
              for await (const chunk of body) chunks.push(chunk);
              return { size, body: blobStream(chunks) };
            },
          },
        },
        options,
      );
    await expect(assertChunkRetention(bufferingArchive)).rejects.toThrow(
      'earlier source chunks must be released while streaming',
    );
  });

  it('streams one 40 MiB blob with peak memory below 32 MiB above baseline', async () => {
    const delta = await peakAboveBaseline([{ path: 'data/big.bin', seed: 7, size: 40 * MIB }]);
    expect(delta).toBeLessThan(PEAK_BOUND);
  });

  it('streams 40 blobs of 1 MiB with peak memory below 32 MiB above baseline', async () => {
    const blobs = Array.from({ length: 40 }, (_, i) => ({
      path: `data/f${String(i).padStart(2, '0')}.bin`,
      seed: i + 1,
      size: MIB,
    }));
    const delta = await peakAboveBaseline(blobs);
    expect(delta).toBeLessThan(PEAK_BOUND);
  });
});
