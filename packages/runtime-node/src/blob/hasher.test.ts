import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import {
  createBlobProbe,
  parseSha256,
  type BlobMetadataPort,
  type ByteStore,
} from '@package-broker/core/platform/blob';
import { createNodeBlobHasher } from './hasher.js';

function source(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]!);
    },
  });
}

const chunks = [Uint8Array.of(1), Uint8Array.of(2, 3, 4, 5, 6), Uint8Array.of(7, 8)];

describe('createNodeBlobHasher', () => {
  it.each([
    ['empty', []],
    ['one chunk', [chunks[0]!]],
    ['three uneven chunks', chunks],
  ] as const)('hashes %s', async (_name, input) => {
    const expected = createHash('sha256').update(Buffer.concat(input)).digest();
    expect(await createNodeBlobHasher().hashStream(source(input))).toEqual(
      new Uint8Array(expected),
    );
  });

  it('hashes a lazy 32 MiB stream with less than 4 MiB heap growth', async () => {
    const expected = createHash('sha256')
      .update(Buffer.alloc(32 * 1024 * 1024, 7))
      .digest();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let remaining = 512;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
        if (remaining-- > 0) controller.enqueue(new Uint8Array(64 * 1024).fill(7));
        else controller.close();
      },
    });
    const actual = await createNodeBlobHasher().hashStream(stream);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    expect(actual).toEqual(new Uint8Array(expected));
    expect(peak - before).toBeLessThan(4 * 1024 * 1024);
    console.info(`32 MiB SHA-256 peak heap growth: ${peak - before} bytes`);
  });

  it.each([false, true])('probes same-size bytes with corruption=%s', async (corrupt) => {
    const bytes = Uint8Array.of(1, 2, 3);
    const key = parseSha256(createHash('sha256').update(bytes).digest('hex'));
    const info = {
      generation: '',
      sha256: key,
      size: bytes.length,
      mediaType: 'application/octet-stream',
      purgeAfter: null,
    };
    const stored = bytes.slice();
    if (corrupt) stored[1] = stored[1]! ^ 1;
    const store = {
      get: async () => ({
        size: stored.length,
        mediaType: info.mediaType,
        range: null,
        body: source([stored]),
      }),
    } as unknown as ByteStore;
    const metadata = {
      inspect: async () => ({ info, purging: false }),
    } as unknown as BlobMetadataPort;
    const probe = createBlobProbe(store, metadata, createNodeBlobHasher());
    expect(await probe.probe(orgContext('org-a'), key)).toBe(corrupt ? 'corrupt' : 'ok');
  });

  it('cancels the reader on a read error and preserves the original failure', async () => {
    const failure = new Error('read failed');
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const releaseLock = vi.fn();
    const stream = {
      getReader: () => ({
        read: async () => {
          throw failure;
        },
        cancel,
        releaseLock,
      }),
    } as unknown as ReadableStream<Uint8Array>;
    await expect(createNodeBlobHasher().hashStream(stream)).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
