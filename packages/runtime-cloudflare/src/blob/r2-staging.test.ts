import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const read = (path: string) =>
  stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'));
const worker = `
import { createR2ByteStore } from './r2.mjs';
export default { async fetch(req, env) {
  const store = createR2ByteStore(env.B);
  const h = 'staging/61/01J00000000000000000000001';
  const size = Number(new URL(req.url).searchParams.get('size'));
  let offset = 0;
  const body = new ReadableStream({pull(c) {
    if (offset === size) return c.close();
    const n = Math.min(131071, size - offset); offset += n; c.enqueue(new Uint8Array(n).fill(17));
  }});
  try {
    const value = await store.putStaged(h, body, 20_000_000, 'application/gzip');
    const staged = await store.openStaged(h);
    const opened = (await new Response(staged).arrayBuffer()).byteLength;
    const listed = await store.listStaged('2099-01-01T00:00:00.000Z');
    await store.promote(h, value.sha256, value.size, 'application/gzip');
    const found = await store.head('npm-publish/sha256/61/' + value.sha256.slice(0,2) + '/' + value.sha256 + '/' + h.split('/')[2]);
    await store.discardStaged(h);
    return Response.json({value, opened, listed: listed.length, found, remaining: (await store.listStaged('2099-01-01T00:00:00.000Z')).length});
  } catch(e) { return Response.json({ error: e.name, message: e.message }, {status: 500}); }
}};`;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: worker },
      {
        type: 'ESModule',
        path: 'r2.mjs',
        contents: read('./r2.ts').replaceAll(
          "'@package-broker/core/platform/blob'",
          "'./blob.mjs'",
        ),
      },
      { type: 'ESModule', path: 'blob.mjs', contents: read('../../../core/src/platform/blob.ts') },
    ],
    compatibilityDate: '2026-01-01',
    r2Buckets: ['B'],
  }),
);
afterAll(() => mf.dispose());
it.each([0, 1, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1, 17_000_000])(
  'stages and promotes %i bytes through R2 multipart',
  async (size) => {
    const res = await mf.dispatchFetch('https://test/?size=' + size);
    const value = (await res.json()) as {
      value: { size: number };
      opened: number;
      listed: number;
      found: { size: number };
      remaining: number;
    };
    expect(res.status, JSON.stringify(value)).toBe(200);
    expect(value.value.size).toBe(size);
    expect(value.opened).toBe(size);
    expect(value.listed).toBe(1);
    expect(value.found.size).toBe(size);
    expect(value.remaining).toBe(0);
  },
);
