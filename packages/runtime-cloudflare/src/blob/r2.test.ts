import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const read = (relative: string): string =>
  stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const adapter = read('./r2.ts').replaceAll("'@package-broker/core/platform/blob'", "'./blob.mjs'");
const core = read('../../../core/src/platform/blob.ts');
if (/^\s*(import|export)\b[^;]*\sfrom\s+'\./m.test(core)) {
  throw new Error('core blob.ts gained a runtime relative import; load it as a module here too');
}

const WORKER = `
import { createR2ByteStore } from './r2.mjs';

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

function source(spec, state) {
  const chunks = spec.chunks.map(fromBase64);
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
      if (spec.failAfter !== undefined && at >= spec.failAfter) {
        controller.error(new Error('upstream failed'));
        return;
      }
      if (at < chunks.length) {
        controller.enqueue(chunks[at]);
        at += 1;
        return;
      }
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

async function drain(stream) {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
  }
  return new Uint8Array(parts);
}

export default {
  async fetch(request, env) {
    const spec = await request.json();
    const out = {};
    try {
      const bucket = spec.rejectPut
        ? {
            put: () => Promise.reject(new Error('put failed')),
            get: () => Promise.resolve(null),
            head: () => Promise.resolve(null),
            delete: () => Promise.resolve(),
          }
        : spec.ignoreRange
        ? {
            put: (...args) => env.B.put(...args),
            get: (key) => env.B.get(key),
            head: (key) => env.B.head(key),
            delete: (key) => env.B.delete(key),
          }
        : env.B;
      const store = createR2ByteStore(bucket);
      if (spec.op === 'put') {
        const state = { cancelled: false };
        try {
          out.result = await store.putVerified(spec.key, source(spec, state), {
            sha256: spec.sha256,
            size: spec.size,
            mediaType: spec.mediaType,
          });
        } finally {
          out.sourceCancelled = state.cancelled;
        }
      } else if (spec.op === 'get') {
        const found = await store.get(spec.key, spec.range);
        out.result = found === null
          ? null
          : { size: found.size, mediaType: found.mediaType, range: found.range, bytes: toBase64(await drain(found.body)) };
      } else if (spec.op === 'head') {
        out.result = await store.head(spec.key);
      } else if (spec.op === 'remove') {
        await store.remove(spec.key);
        out.result = 'removed';
      }
    } catch (error) {
      out.error = error.name;
      out.message = error.message;
    }
    out.exists = spec.key === undefined ? undefined : (await env.B.head(spec.key)) !== null;
    return Response.json(out);
  },
};
`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: WORKER },
      { type: 'ESModule', path: 'r2.mjs', contents: adapter },
      { type: 'ESModule', path: 'blob.mjs', contents: core },
    ],
    compatibilityDate: '2026-10-01',
    r2Buckets: ['B'],
  } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Outcome {
  result?: unknown;
  error?: string;
  message?: string;
  exists?: boolean;
  sourceCancelled?: boolean;
}

async function run(spec: Record<string, unknown>): Promise<Outcome> {
  const response = await mf.dispatchFetch('http://r2.test/', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return (await response.json()) as Outcome;
}

let counter = 0;
const freshKey = (): string => `sha256/6f72672d31/ab/key-${(counter += 1)}`;

async function upload(
  data: Uint8Array,
  overrides: Record<string, unknown> = {},
  split: number[] = [data.length],
): Promise<{ key: string; outcome: Outcome }> {
  const key = (overrides.key as string | undefined) ?? freshKey();
  const chunks: string[] = [];
  let at = 0;
  for (const length of split) {
    chunks.push(toBase64(data.subarray(at, at + length)));
    at += length;
  }
  const outcome = await run({
    op: 'put',
    key,
    chunks,
    sha256: await sha256Of(data),
    size: data.length,
    mediaType: 'application/zip',
    ...overrides,
  });
  return { key, outcome };
}

const payload = encoder.encode('0123456789abcdefghijklmnopqrstuvwxyz');

describe('R2 byte store', () => {
  it('round-trips bytes, size and media type', async () => {
    const { key, outcome } = await upload(payload, {}, [10, 10, 16]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({ size: payload.length, mediaType: 'application/zip' });
    const read = await run({ op: 'get', key });
    expect(read.result).toEqual({
      size: payload.length,
      mediaType: 'application/zip',
      range: null,
      bytes: toBase64(payload),
    });
    expect((await run({ op: 'head', key })).result).toEqual({
      size: payload.length,
      mediaType: 'application/zip',
    });
  });

  it('stores an empty object', async () => {
    const { key, outcome } = await upload(new Uint8Array(0), {}, []);
    expect(outcome.error).toBeUndefined();
    expect((await run({ op: 'head', key })).result).toEqual({
      size: 0,
      mediaType: 'application/zip',
    });
  });

  it('rejects a checksum mismatch and publishes nothing', async () => {
    const { outcome } = await upload(payload, { sha256: 'a'.repeat(64) });
    expect(outcome.error).toBe('BlobValidationError');
    expect(outcome.exists).toBe(false);
  });

  it('rejects early EOF and publishes nothing', async () => {
    const { outcome } = await upload(payload, { size: payload.length + 5 });
    expect(outcome.error).toBe('BlobSizeMismatchError');
    expect(outcome.exists).toBe(false);
  });

  it('rejects overflow and publishes nothing', async () => {
    const { outcome } = await upload(payload, { size: payload.length - 5 });
    expect(outcome.error).toBe('BlobSizeMismatchError');
    expect(outcome.exists).toBe(false);
  });

  it('propagates a failing source to the put and publishes nothing', async () => {
    const { outcome } = await upload(payload, { failAfter: 1 }, [10, 10, 16]);
    expect(outcome.error).toBe('Error');
    expect(outcome.message).toBe('upstream failed');
    expect(outcome.exists).toBe(false);
  });

  it('does not publish an overflow that lands on a chunk boundary', async () => {
    const { outcome } = await upload(
      payload,
      { size: 10, sha256: await sha256Of(payload.subarray(0, 10)) },
      [10, 10, 16],
    );
    expect(outcome.error).toBe('BlobSizeMismatchError');
    expect(outcome.exists).toBe(false);
  });

  it('does not publish an overflow after an empty chunk', async () => {
    const { outcome } = await upload(
      payload,
      { size: 10, sha256: await sha256Of(payload.subarray(0, 10)) },
      [10, 0, 26],
    );
    expect(outcome.error).toBe('BlobSizeMismatchError');
    expect(outcome.exists).toBe(false);
  });

  it('does not publish an empty object when a slow source later sends a byte', async () => {
    const { outcome } = await upload(
      new Uint8Array([1]),
      { size: 0, sha256: await sha256Of(new Uint8Array(0)), delayMs: 50 },
      [1],
    );
    expect(outcome.error).toBe('BlobSizeMismatchError');
    expect(outcome.exists).toBe(false);
  });

  it('settles with the put error when the bucket rejects without reading the body', async () => {
    const { outcome } = await upload(payload, { rejectPut: true }, [10, 10, 16]);
    expect(outcome.error).toBe('Error');
    expect(outcome.message).toBe('put failed');
    expect(outcome.sourceCancelled).toBe(true);
  });

  it('cancels the source on overflow', async () => {
    const { outcome } = await upload(payload, { size: 12 }, [10, 10, 16]);
    expect(outcome.error).toBe('BlobSizeMismatchError');
    expect(outcome.sourceCancelled).toBe(true);
    expect(outcome.exists).toBe(false);
  });

  it('keeps existing bytes and media type when a bad upload targets the same key', async () => {
    const { key } = await upload(payload);
    const bad = await upload(encoder.encode('different bytes'), {
      key,
      sha256: await sha256Of(payload),
      size: payload.length,
    });
    expect(bad.outcome.error).toBeDefined();
    const read = await run({ op: 'get', key });
    expect((read.result as { bytes: string }).bytes).toBe(toBase64(payload));
  });

  it('reports the stored media type when the same digest is uploaded again with another type', async () => {
    const { key } = await upload(payload);
    const again = await upload(payload, { key, mediaType: 'application/gzip' });
    expect(again.outcome.result).toEqual({ size: payload.length, mediaType: 'application/zip' });
    expect((await run({ op: 'head', key })).result).toEqual({
      size: payload.length,
      mediaType: 'application/zip',
    });
  });

  it('returns exactly the requested range with the total size', async () => {
    const { key } = await upload(payload);
    const read = await run({ op: 'get', key, range: { offset: 5, length: 7 } });
    expect(read.result).toEqual({
      size: payload.length,
      mediaType: 'application/zip',
      range: { offset: 5, length: 7 },
      bytes: toBase64(payload.subarray(5, 12)),
    });
  });

  it('rejects a ranged read answered with the full body', async () => {
    const { key } = await upload(payload);
    const read = await run({ op: 'get', key, range: { offset: 5, length: 7 }, ignoreRange: true });
    expect(read.error).toBe('BlobSizeMismatchError');
  });

  it('returns null for a missing key', async () => {
    const key = freshKey();
    expect((await run({ op: 'get', key })).result).toBeNull();
    expect((await run({ op: 'head', key })).result).toBeNull();
  });

  it('removes an object, and removing a missing key succeeds', async () => {
    const { key } = await upload(payload);
    expect((await run({ op: 'remove', key })).exists).toBe(false);
    expect((await run({ op: 'remove', key })).error).toBeUndefined();
  });
});
