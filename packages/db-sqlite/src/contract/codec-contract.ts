import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync, inflateRawSync, deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { Codecs, DigestAlgorithm } from '@package-broker/core/platform/codec';

/**
 * Operations run where the codec lives: in process on Node, inside workerd on Workers. Both
 * runtimes load this same source, so a case cannot drift between them. Byte payloads cross the
 * boundary as base64 and digests as lowercase hex.
 */
export const codecOpRunnerSource = String.raw`
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toB64 = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describeError = (e) => ({ error: e?.name ?? 'Error', message: String(e?.message ?? e) });

function source(chunks, state, failWith) {
  let at = 0;
  state.inputBytes = 0;
  return new ReadableStream({
    pull(controller) {
      if (at < chunks.length) {
        const chunk = chunks[at++];
        state.inputBytes += chunk.length;
        controller.enqueue(chunk.slice());
      }
      else if (failWith) controller.error(new Error(failWith));
      else controller.close();
    },
    cancel(reason) {
      state.cancelled = String(reason?.message ?? reason);
    },
  }, { highWaterMark: 0 });
}

async function drain(stream, out, keep, slow) {
  const parts = [];
  out.length = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.length += value.length;
    if (keep) parts.push(value);
    if (slow) await sleep(0);
  }
  if (!keep) return;
  const all = new Uint8Array(out.length);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  out.output = toB64(all);
}

async function settle(promise, ms) {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (e) => ({ rejected: String(e?.message ?? e) }),
    ),
    sleep(ms).then(() => ({ pending: true })),
  ]);
}

export async function runOp(codecs, spec) {
  const out = {};
  const chunks = (spec.chunks ?? []).map(fromB64);
  try {
    if (spec.op === 'digest') {
      const tap = codecs.digestTap(spec.algs);
      const state = {};
      try {
        await drain(source(chunks, state, spec.failWith).pipeThrough(tap.transform), out, true, spec.slow);
      } catch (e) {
        Object.assign(out, describeError(e));
      }
      const d = await settle(tap.digests, 2000);
      if (d.value) out.digests = Object.fromEntries(Object.entries(d.value).map(([k, v]) => [k, hex(v)]));
      else if (d.rejected !== undefined) out.digestsError = d.rejected;
      else out.digestsPending = true;
    } else if (spec.op === 'digestCancel') {
      const state = {};
      const src = new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(16));
        },
        cancel(reason) {
          state.cancelled = String(reason?.message ?? reason);
        },
      }, { highWaterMark: 0 });
      const tap = codecs.digestTap(['sha256']);
      const reader = src.pipeThrough(tap.transform).getReader();
      await reader.read();
      await reader.cancel(new Error('stop'));
      const d = await settle(tap.digests, 2000);
      out.digestsError = d.rejected;
      await sleep(20);
      out.sourceCancelled = state.cancelled;
    } else if (spec.op === 'digestAbort') {
      const tap = codecs.digestTap(['sha256']);
      await tap.transform.writable.getWriter().abort(new Error('boom'));
      out.digestsError = (await settle(tap.digests, 2000)).rejected;
      out.readableAfterAbort = await settle(tap.transform.readable.getReader().read(), 2000);
    } else if (spec.op === 'backpressure') {
      let pulls = 0;
      const src = new ReadableStream({
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(spec.size));
        },
      }, { highWaterMark: 0 });
      const tap = codecs.digestTap(['sha256']);
      const reader = src.pipeThrough(tap.transform).getReader();
      await reader.read();
      await sleep(spec.pauseMs);
      out.pulls = pulls;
      await reader.cancel();
    } else if (spec.op === 'inflate') {
      const r = codecs.inflateConsumed(chunks[0], spec.max, spec.expected);
      out.data = toB64(r.data);
      out.consumed = r.consumed;
    } else if (spec.op === 'gunzip' || spec.op === 'deflateRaw') {
      const t = spec.op === 'gunzip' ? codecs.gunzip(spec.max) : codecs.deflateRaw();
      const state = {};
      try {
        await drain(source(chunks, state).pipeThrough(t), out, spec.keep !== false, spec.slow);
      } catch (e) {
        Object.assign(out, describeError(e));
        out.operation = e?.operation;
      }
      out.inputBytes = state.inputBytes;
    }
  } catch (e) {
    Object.assign(out, describeError(e));
    out.operation = e?.operation;
  }
  return out;
}
`;

export interface CodecSpec {
  readonly op:
    | 'digest'
    | 'digestCancel'
    | 'digestAbort'
    | 'backpressure'
    | 'inflate'
    | 'gunzip'
    | 'deflateRaw';
  readonly chunks?: readonly string[];
  readonly algs?: readonly DigestAlgorithm[];
  readonly max?: number;
  readonly expected?: number;
  readonly size?: number;
  readonly pauseMs?: number;
  readonly keep?: boolean;
  readonly slow?: boolean;
  readonly failWith?: string;
}

export interface CodecOutcome {
  output?: string;
  length?: number;
  digests?: Record<string, string>;
  digestsError?: string;
  digestsPending?: boolean;
  readableAfterAbort?: { rejected?: string; pending?: boolean; value?: unknown };
  inputBytes?: number;
  data?: string;
  consumed?: number;
  error?: string;
  message?: string;
  operation?: string;
  pulls?: number;
  sourceCancelled?: string;
}

export type CodecRunner = (spec: CodecSpec) => Promise<CodecOutcome>;

export async function loadCodecRunner(codecs: Codecs): Promise<CodecRunner> {
  const url = `data:text/javascript;base64,${Buffer.from(codecOpRunnerSource).toString('base64')}`;
  const module = (await import(/* @vite-ignore */ url)) as {
    runOp(codecs: Codecs, spec: CodecSpec): Promise<CodecOutcome>;
  };
  return (spec) => module.runOp(codecs, spec);
}

export const CODEC_CONTRACT_CASES = [
  'digest vectors match node:crypto under random chunking',
  'digest known answers for the empty message',
  'backpressure: a paused consumer leaves at most two chunks buffered in the tap',
  'cancel propagates to the source and rejects digests',
  'writer abort and source error reject digests and error the readable side',
  'inflateConsumed reports consumed bytes with trailing data',
  'inflateConsumed throws CodecTruncatedError on truncated input',
  'inflateConsumed throws CodecLimitError past maxOutput',
  'gunzip joins concatenated members',
  'gunzip stops a bomb (ratio above 1000) at maxOutput',
  'deflateRaw round trips under random chunking',
] as const;

const ALGS: readonly DigestAlgorithm[] = ['sha1', 'sha256', 'sha384', 'sha512'];
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromB64 = (text: string | undefined): Buffer => Buffer.from(text ?? '', 'base64');

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomChunks(data: Uint8Array, random: () => number, maxChunk: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < data.length;) {
    const size = Math.min(data.length - at, Math.floor(random() * maxChunk) + 1);
    chunks.push(data.subarray(at, at + size));
    at += size;
  }
  return chunks;
}

/**
 * Every case must run: the suite hook fails when any registered case did not execute, so a
 * filtered or skipped case is a failure, not a pass.
 */
export function describeCodecContract(name: string, run: CodecRunner): void {
  const executed = new Set<string>();
  const contractCase = (
    title: (typeof CODEC_CONTRACT_CASES)[number],
    body: () => Promise<void>,
  ): void => {
    it(title, async () => {
      await body();
      executed.add(title);
    });
  };

  describe(`${name} codec contract`, () => {
    contractCase(CODEC_CONTRACT_CASES[0], async () => {
      const random = seededRandom(356);
      for (let round = 0; round < 25; round++) {
        const data = Uint8Array.from({ length: Math.floor(random() * 9000) }, () =>
          Math.floor(random() * 256),
        );
        const r = await run({
          op: 'digest',
          algs: ALGS,
          chunks: randomChunks(data, random, 700).map(b64),
          slow: round % 5 === 0,
        });
        expect(new Uint8Array(fromB64(r.output))).toEqual(data);
        for (const alg of ALGS) {
          expect(r.digests?.[alg]).toBe(createHash(alg).update(data).digest('hex'));
        }
      }
    });

    contractCase(CODEC_CONTRACT_CASES[1], async () => {
      const r = await run({ op: 'digest', algs: ALGS, chunks: [] });
      expect(r.digests?.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
      expect(r.digests?.sha256).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    contractCase(CODEC_CONTRACT_CASES[2], async () => {
      const r = await run({ op: 'backpressure', size: 65_536, pauseMs: 50 });
      expect(r.pulls).toBeGreaterThanOrEqual(1);
      expect((r.pulls ?? 0) - 1).toBeLessThanOrEqual(2);
    });

    contractCase(CODEC_CONTRACT_CASES[3], async () => {
      const r = await run({ op: 'digestCancel' });
      expect(r.digestsError).toBe('stop');
      expect(r.sourceCancelled).toBe('stop');
    });

    contractCase(CODEC_CONTRACT_CASES[4], async () => {
      const aborted = await run({ op: 'digestAbort' });
      expect(aborted.digestsError).toBe('boom');
      expect(aborted.readableAfterAbort).toEqual({ rejected: 'boom' });
      const r = await run({
        op: 'digest',
        algs: ['sha256'],
        chunks: [b64(Uint8Array.of(1, 2, 3))],
        failWith: 'source-broke',
      });
      expect(r.message).toBe('source-broke');
      expect(r.digestsError).toBe('source-broke');
      expect(r.digests).toBeUndefined();
    });

    const payload = Buffer.from('packfile object '.repeat(40));
    const stream = deflateSync(payload);

    contractCase(CODEC_CONTRACT_CASES[5], async () => {
      const trailer = Buffer.from('NEXT-OBJECT-BYTES');
      const r = await run({
        op: 'inflate',
        chunks: [b64(Buffer.concat([stream, trailer]))],
        max: 10_000,
      });
      expect(r.consumed).toBe(stream.length);
      expect(fromB64(r.data)).toEqual(payload);
    });

    contractCase(CODEC_CONTRACT_CASES[6], async () => {
      const r = await run({
        op: 'inflate',
        chunks: [b64(stream.subarray(0, stream.length - 3))],
        max: 10_000,
      });
      expect(r.error).toBe('CodecTruncatedError');
    });

    contractCase(CODEC_CONTRACT_CASES[7], async () => {
      const at = await run({ op: 'inflate', chunks: [b64(stream)], max: payload.length });
      expect(fromB64(at.data)).toEqual(payload);
      const over = await run({ op: 'inflate', chunks: [b64(stream)], max: payload.length - 1 });
      expect(over.error).toBe('CodecLimitError');
    });

    contractCase(CODEC_CONTRACT_CASES[8], async () => {
      const gz = Buffer.concat([gzipSync('ab'), gzipSync('cd')]);
      const r = await run({
        op: 'gunzip',
        chunks: Array.from(gz, (b) => b64(Uint8Array.of(b))),
        max: 100,
      });
      expect(fromB64(r.output).toString()).toBe('abcd');
    });

    contractCase(CODEC_CONTRACT_CASES[9], async () => {
      const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
      expect((64 * 1024 * 1024) / bomb.length).toBeGreaterThan(1000);
      const max = 1024 * 1024;
      const r = await run({
        op: 'gunzip',
        chunks: Array.from({ length: Math.ceil(bomb.length / 256) }, (_, i) =>
          b64(bomb.subarray(i * 256, (i + 1) * 256)),
        ),
        max,
        keep: false,
      });
      expect(r.error).toBe('CodecLimitError');
      expect(r.operation).toBe('gunzip');
      expect(r.length ?? 0).toBeLessThanOrEqual(max);
      // Allow bounded codec read-ahead, while leaving most of the bomb upstream.
      expect(r.inputBytes).toBeGreaterThan(0);
      expect(r.inputBytes).toBeLessThanOrEqual(4096);
    });

    contractCase(CODEC_CONTRACT_CASES[10], async () => {
      const random = seededRandom(7);
      for (const length of [0, 1, 5000, 200_000]) {
        const data = Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 7)) & 0xff);
        const r = await run({
          op: 'deflateRaw',
          chunks: randomChunks(data, random, 4096).map(b64),
        });
        expect(new Uint8Array(inflateRawSync(fromB64(r.output)))).toEqual(data);
      }
      expect(deflateRawSync(Buffer.alloc(0)).length).toBeGreaterThan(0);
    });

    afterAll(() => {
      expect([...executed].sort()).toEqual([...CODEC_CONTRACT_CASES].sort());
    });
  });
}
