import { deflateRawSync, deflateSync, gzipSync, inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const read = (relative: string): string =>
  stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    mode: 'transform',
  });

const adapter = read('./workers-codec.ts').replaceAll(
  "'@package-broker/core/platform/codec'",
  "'./codec-core.mjs'",
);
const core = read('../../../core/src/platform/codec.ts');
if (/^\s*(import|export)\b[^;]*\sfrom\s+'\./m.test(core)) {
  throw new Error('core codec.ts gained a runtime relative import; load it as a module here too');
}

const WORKER = `
import { workersCodecs } from './workers-codec.mjs';

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64 = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function source(chunks, state) {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at < chunks.length) controller.enqueue(chunks[at++]);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

async function drain(stream, slow) {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
    if (slow) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Uint8Array(parts);
}

const failure = (e) => ({ error: e?.name ?? 'Error', message: String(e?.message ?? e) });

export default {
  async fetch(request) {
    const spec = await request.json();
    const chunks = (spec.chunks ?? []).map(fromBase64);
    const out = {};
    try {
      if (spec.op === 'digest') {
        const tap = workersCodecs.digestTap(spec.algs);
        const state = {};
        let produced;
        try {
          produced = await drain(source(chunks, state).pipeThrough(tap.transform), spec.slow);
          out.output = toBase64(produced);
        } catch (e) {
          Object.assign(out, failure(e));
        }
        try {
          const d = await tap.digests;
          out.digests = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, hex(v)]));
        } catch (e) {
          out.digestsError = String(e?.message ?? e);
        }
      } else if (spec.op === 'digestOpen') {
        const tap = workersCodecs.digestTap(['sha256']);
        const writer = tap.transform.writable.getWriter();
        const reading = drain(tap.transform.readable);
        await writer.write(chunks[0]);
        let settled = false;
        tap.digests.then(() => (settled = true), () => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        out.settledBeforeClose = settled;
        await writer.close();
        await reading;
        out.digests = Object.fromEntries(
          Object.entries(await tap.digests).map(([k, v]) => [k, hex(v)]),
        );
      } else if (spec.op === 'digestCancel') {
        const tap = workersCodecs.digestTap(['sha256']);
        await tap.transform.readable.getReader().cancel(new Error('stop'));
        try {
          await tap.digests;
        } catch (e) {
          out.digestsError = String(e?.message ?? e);
        }
      } else if (spec.op === 'digestAbort') {
        const tap = workersCodecs.digestTap(['sha256']);
        await tap.transform.writable.getWriter().abort(new Error('boom'));
        try {
          await tap.digests;
        } catch (e) {
          out.digestsError = String(e?.message ?? e);
        }
      } else if (spec.op === 'digestBackpressure') {
        let pulls = 0;
        const src = new ReadableStream({
          pull(c) {
            pulls++;
            c.enqueue(chunks[0]);
          },
        });
        const tap = workersCodecs.digestTap(['sha256']);
        const reader = src.pipeThrough(tap.transform).getReader();
        await reader.read();
        await new Promise((resolve) => setTimeout(resolve, 20));
        out.pulls = pulls;
        await reader.cancel();
      } else if (spec.op === 'inflate') {
        const r = workersCodecs.inflateConsumed(chunks[0], spec.max);
        out.data = toBase64(r.data);
        out.consumed = r.consumed;
        out.exact = r.data.buffer.byteLength === r.data.length;
      } else if (spec.op === 'gunzip' || spec.op === 'deflateRaw') {
        const t = spec.op === 'gunzip' ? workersCodecs.gunzip(spec.max) : workersCodecs.deflateRaw();
        out.output = toBase64(await drain(source(chunks, {}).pipeThrough(t), spec.slow));
      } else if (spec.op === 'digestTransformFails') {
        const tap = workersCodecs.digestTap(['sha256', 'sha512']);
        const writer = tap.transform.writable.getWriter();
        tap.transform.readable.getReader().read().catch(() => undefined);
        writer.write(5).catch(() => undefined);
        const settled = await Promise.race([
          tap.digests.then(
            () => 'resolved',
            () => 'rejected',
          ),
          new Promise((resolve) => setTimeout(() => resolve('pending'), 2000)),
        ]);
        out.digestsOutcome = settled;
      } else if (spec.op === 'gunzipCancelPending') {
        const t = workersCodecs.gunzip(spec.max);
        const writer = t.writable.getWriter();
        const write = writer.write(chunks[0]).then(
          () => 'written',
          () => 'rejected',
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await t.readable.cancel(new Error('stop'));
        const aborted = writer.abort(new Error('stop')).then(
          () => 'aborted',
          () => 'abort-rejected',
        );
        const timeout = new Promise((resolve) => setTimeout(() => resolve('pending'), 2000));
        out.write = await Promise.race([write, timeout]);
        out.abort = await Promise.race([aborted, timeout]);
      } else if (spec.op === 'gunzipStalled') {
        const t = workersCodecs.gunzip(spec.max);
        const writer = t.writable.getWriter();
        writer.write(chunks[0]).catch(() => undefined);
        const reader = t.readable.getReader();
        out.outcome = await Promise.race([
          (async () => {
            for (;;) if ((await reader.read()).done) return 'done';
          })().catch((e) => failure(e).error),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
        ]);
      }
    } catch (e) {
      Object.assign(out, failure(e));
    }
    return Response.json(out);
  },
};
`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: WORKER },
      { type: 'ESModule', path: 'workers-codec.mjs', contents: adapter },
      { type: 'ESModule', path: 'codec-core.mjs', contents: core },
    ],
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
  } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

interface Outcome {
  output?: string;
  digests?: Record<string, string>;
  digestsError?: string;
  data?: string;
  consumed?: number;
  exact?: boolean;
  error?: string;
  message?: string;
  settledBeforeClose?: boolean;
  pulls?: number;
  outcome?: string;
  digestsOutcome?: string;
  write?: string;
  abort?: string;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

async function run(
  op: string,
  chunks: readonly Uint8Array[],
  extra: object = {},
): Promise<Outcome> {
  const response = await mf.dispatchFetch('http://codec.test/', {
    method: 'POST',
    body: JSON.stringify({ op, chunks: chunks.map(b64), ...extra }),
  });
  return (await response.json()) as Outcome;
}

const fromB64 = (text: string | undefined): Buffer => Buffer.from(text ?? '', 'base64');

const ALGS = ['sha1', 'sha256', 'sha384', 'sha512'];
const EXPECTED: Record<string, string> = {
  sha1: '3e7e19ea8f559bd1f5c97e46f0ae082c4bcd6244',
  sha256: 'fb1907e541f9c81501e95cc95fbfacb263bab1990ae9b54272673d5107511d52',
  sha384:
    'f7c387e71f3cbd4e27f8df78c05b2600c81264bf16246a488832beb73d2cfc603c13de0441b245f41fff87f1f70d47bc',
  sha512:
    'c992c4e85caf0961560f3da2b47ee23d3c261b4fae3e9fe9bc6e4a5b7e026d9f74d8a396443d4564be77a575201d3fb8285f2fc332f6623442cb3817573ad0e5',
};
const message = Uint8Array.from({ length: 70 }, (_, i) => (i * 7 + 3) & 0xff);

describe('workersCodecs digestTap', () => {
  it('known answers for the empty message', async () => {
    const r = await run('digest', [], { algs: ALGS });
    expect(r.digests?.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(r.digests?.sha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  for (let split = 0; split <= message.length; split++) {
    it(`matches the known answers with the 70-byte input split at ${split}`, async () => {
      const r = await run('digest', [message.subarray(0, split), message.subarray(split)], {
        algs: ALGS,
      });
      expect(new Uint8Array(fromB64(r.output))).toEqual(message);
      expect(r.digests).toEqual(EXPECTED);
    });
  }

  it('is correct with a slow consumer that reads one chunk per tick', async () => {
    const chunks = Array.from(message, (b) => Uint8Array.of(b));
    const r = await run('digest', chunks, { algs: ALGS, slow: true });
    expect(new Uint8Array(fromB64(r.output))).toEqual(message);
    expect(r.digests).toEqual(EXPECTED);
  });

  it('does not settle digests before the writable closes', async () => {
    const r = await run('digestOpen', [message]);
    expect(r.settledBeforeClose).toBe(false);
    expect(r.digests?.sha256).toBe(EXPECTED.sha256);
  });

  it('rejects digests when the stream is cancelled', async () => {
    expect((await run('digestCancel', [])).digestsError).toBe('stop');
  });

  it('rejects digests when the writer aborts', async () => {
    expect((await run('digestAbort', [])).digestsError).toBe('boom');
  });

  it('rejects digests when the transform itself fails', async () => {
    expect((await run('digestTransformFails', [])).digestsOutcome).toBe('rejected');
  });

  it('drives reads by pull', async () => {
    const r = await run('digestBackpressure', [message]);
    expect(r.pulls).toBeLessThanOrEqual(4);
  });
});

describe('workersCodecs inflateConsumed', () => {
  const payload = Buffer.from('packfile object '.repeat(40));
  const stream = deflateSync(payload);

  it('returns the exact consumed length when trailing bytes follow', async () => {
    const trailer = Buffer.from('NEXT-OBJECT-BYTES');
    const r = await run('inflate', [Buffer.concat([stream, trailer])], { max: 10_000 });
    expect(r.consumed).toBe(stream.length);
    expect(fromB64(r.data)).toEqual(payload);
    expect(r.exact).toBe(true);
  });

  it('accepts output exactly at the limit', async () => {
    const r = await run('inflate', [stream], { max: payload.length });
    expect(fromB64(r.data).length).toBe(payload.length);
  });

  it('throws CodecLimitError past maxOutput', async () => {
    expect((await run('inflate', [stream], { max: payload.length - 1 })).error).toBe(
      'CodecLimitError',
    );
    expect((await run('inflate', [stream], { max: 0 })).error).toBe('CodecLimitError');
  });

  it('accepts a zero limit for an empty stream', async () => {
    const empty = deflateSync(Buffer.alloc(0));
    const r = await run('inflate', [Buffer.concat([empty, Buffer.from('xx')])], { max: 0 });
    expect(fromB64(r.data).length).toBe(0);
    expect(r.consumed).toBe(empty.length);
  });

  it('rejects an invalid maxOutput with RangeError', async () => {
    for (const bad of [-1, 1.5, 2 ** 53]) {
      expect((await run('inflate', [stream], { max: bad })).error).toBe('RangeError');
      expect((await run('gunzip', [], { max: bad })).error).toBe('RangeError');
    }
  });

  it('throws CodecTruncatedError when the stream is cut short', async () => {
    const r = await run('inflate', [stream.subarray(0, stream.length - 3)], { max: 10_000 });
    expect(r.error).toBe('CodecTruncatedError');
  });

  it('throws CodecCorruptError for invalid data and for raw deflate', async () => {
    expect((await run('inflate', [Buffer.from('zzzzzzzz')], { max: 100 })).error).toBe(
      'CodecCorruptError',
    );
    expect((await run('inflate', [deflateRawSync(payload)], { max: 10_000 })).error).toBe(
      'CodecCorruptError',
    );
  });
});

describe('workersCodecs gunzip', () => {
  it('joins concatenated members, however the input is chunked', async () => {
    const gz = Buffer.concat([gzipSync('ab'), gzipSync('cd')]);
    const chunks = Array.from(gz, (b) => Uint8Array.of(b));
    const r = await run('gunzip', chunks, { max: 100 });
    expect(fromB64(r.output).toString()).toBe('abcd');
  });

  it('works with a slow consumer', async () => {
    const data = Buffer.alloc(300_000, 'x');
    const gz = gzipSync(data);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < gz.length; i += 100) chunks.push(gz.subarray(i, i + 100));
    const r = await run('gunzip', chunks, { max: 1_000_000, slow: true });
    expect(fromB64(r.output).equals(data)).toBe(true);
  });

  it('errors with CodecLimitError past maxOutput', async () => {
    const r = await run('gunzip', [gzipSync(Buffer.alloc(100_000))], { max: 1000 });
    expect(r.error).toBe('CodecLimitError');
  });

  it('allows output exactly at the limit', async () => {
    const r = await run('gunzip', [gzipSync(Buffer.alloc(1000))], { max: 1000 });
    expect(fromB64(r.output).length).toBe(1000);
  });

  it('errors with CodecTruncatedError when input ends inside a member', async () => {
    const gz = gzipSync('hello world');
    const r = await run('gunzip', [gz.subarray(0, gz.length - 4)], { max: 100 });
    expect(r.error).toBe('CodecTruncatedError');
  });

  it('errors with CodecCorruptError for bad header and trailing junk', async () => {
    expect((await run('gunzip', [Buffer.from('not gzip data')], { max: 100 })).error).toBe(
      'CodecCorruptError',
    );
    const junk = Buffer.concat([gzipSync('ab'), Buffer.from('junk')]);
    expect((await run('gunzip', [junk], { max: 100 })).error).toBe('CodecCorruptError');
  });

  it('rejects zero padding after a member as corrupt', async () => {
    const padded = Buffer.concat([gzipSync('ab'), Buffer.alloc(3)]);
    expect((await run('gunzip', [padded], { max: 100 })).error).toBe('CodecCorruptError');
  });

  it('treats empty input as truncated', async () => {
    expect((await run('gunzip', [], { max: 100 })).error).toBe('CodecTruncatedError');
  });

  it('settles a pending write and the abort when the reader cancels', async () => {
    const gz = gzipSync(Buffer.alloc(32 * 1024 * 1024));
    const r = await run('gunzipCancelPending', [gz], { max: 64 * 1024 * 1024 });
    expect(r.write).toBe('rejected');
    expect(r.abort).toBe('aborted');
  });

  it('surfaces the limit error while upstream stalls', async () => {
    const r = await run('gunzipStalled', [gzipSync(Buffer.alloc(100_000))], { max: 1000 });
    expect(r.outcome).toBe('CodecLimitError');
  });
});

describe('workersCodecs deflateRaw', () => {
  it('produces a raw deflate stream that inflates back', async () => {
    const r = await run('deflateRaw', [message.subarray(0, 30), message.subarray(30)]);
    expect(new Uint8Array(inflateRawSync(fromB64(r.output)))).toEqual(message);
  });
});
