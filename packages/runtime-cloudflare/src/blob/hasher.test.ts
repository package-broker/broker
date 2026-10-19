import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createWorkersBlobHasher } from './hasher.js';

const read = (relative: string): string =>
  stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const worker = `
import { createWorkersBlobHasher } from './hasher.mjs';
import { createBlobProbe, parseSha256 } from './blob.mjs';

export default {
  async fetch(request) {
    const spec = await request.json();
    const chunks = spec.chunks.map((chunk) => new Uint8Array(chunk));
    let remaining = spec.large ? 512 : chunks.length;
    let index = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(spec.large ? new Uint8Array(64 * 1024).fill(7) : chunks[index++]);
        else controller.close();
      },
    });
    let digestStream = false;
    const pipeTo = stream.pipeTo.bind(stream);
    stream.pipeTo = (destination, options) => {
      digestStream = destination instanceof crypto.DigestStream;
      return pipeTo(destination, options);
    };
    const hasher = createWorkersBlobHasher();
    if (spec.key) {
      const key = parseSha256(spec.key);
      const info = { generation: '', sha256: key, size: 3, mediaType: 'application/octet-stream', purgeAfter: null };
      const store = { get: async () => ({ size: 3, mediaType: info.mediaType, range: null, body: stream }) };
      const metadata = { inspect: async () => ({ info, purging: false }) };
      const probe = createBlobProbe(store, metadata, hasher);
      return Response.json({ result: await probe.probe({ orgId: 'org-a' }, key) });
    }
    const digest = await hasher.hashStream(stream);
    return Response.json({ hex: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''), digestStream });
  },
};
`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: worker },
      { type: 'ESModule', path: 'hasher.mjs', contents: read('./hasher.ts') },
      { type: 'ESModule', path: 'blob.mjs', contents: read('../../../core/src/platform/blob.ts') },
    ],
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
  } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

async function run(
  spec: object,
): Promise<{ hex?: string; digestStream?: boolean; result?: string }> {
  const response = await mf.dispatchFetch('http://hasher.test/', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { hex?: string; digestStream?: boolean; result?: string };
}

describe('createWorkersBlobHasher', () => {
  it.each([
    ['empty', []],
    ['one chunk', [[1, 2, 3]]],
    ['three uneven chunks', [[1], [2, 3, 4, 5, 6], [7, 8]]],
  ] as const)('hashes %s using DigestStream', async (_name, chunks) => {
    const expected = createHash('sha256').update(Buffer.from(chunks.flat())).digest('hex');
    expect(await run({ chunks })).toEqual({ hex: expected, digestStream: true });
  });

  it('hashes a lazy 32 MiB stream into a native DigestStream', async () => {
    const expected = createHash('sha256')
      .update(Buffer.alloc(32 * 1024 * 1024, 7))
      .digest('hex');
    expect(await run({ chunks: [], large: true })).toEqual({ hex: expected, digestStream: true });
  });

  it.each([false, true])('probes same-size bytes with corruption=%s', async (corrupt) => {
    const bytes = Buffer.from([1, 2, 3]);
    const key = createHash('sha256').update(bytes).digest('hex');
    if (corrupt) bytes[1] = bytes[1]! ^ 1;
    expect((await run({ chunks: [[...bytes]], key })).result).toBe(corrupt ? 'corrupt' : 'ok');
  });

  it('refuses hashing when DigestStream is unavailable', async () => {
    await expect(
      createWorkersBlobHasher().hashStream(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      ),
    ).rejects.toThrow('crypto.DigestStream is unavailable in this runtime');
  });
});
