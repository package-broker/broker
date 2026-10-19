import { describe, expect, it, vi } from 'vitest';
import type { Codecs } from '@package-broker/core/platform/codec';
import {
  CODEC_CONTRACT_CASES,
  describeCodecContract,
  loadCodecRunner,
  type CodecRunner,
} from './codec-contract.js';

const registration = vi.hoisted(() => ({
  collecting: false,
  cases: new Map<string, () => Promise<void>>(),
  hooks: [] as (() => void)[],
}));

vi.mock('vitest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vitest')>();
  return {
    ...actual,
    describe: (name: string, body: () => void) =>
      registration.collecting ? body() : actual.describe(name, body),
    it: (name: string, body: () => Promise<void>) =>
      registration.collecting ? registration.cases.set(name, body) : actual.it(name, body),
    afterAll: (body: () => void) =>
      registration.collecting ? registration.hooks.push(body) : actual.afterAll(body),
  };
});

function register(run: CodecRunner): void {
  registration.cases.clear();
  registration.hooks.length = 0;
  registration.collecting = true;
  try {
    describeCodecContract('regression', run);
  } finally {
    registration.collecting = false;
  }
}

const unimplemented: Codecs = {
  digestTap: () => {
    throw new TypeError('not implemented');
  },
  inflateConsumed: () => {
    throw new TypeError('not implemented');
  },
  gunzip: () => {
    throw new TypeError('not implemented');
  },
  deflateRaw: () => {
    throw new TypeError('not implemented');
  },
};

describe('codec contract runner', () => {
  it('reports a codec failure by name instead of throwing', async () => {
    const run = await loadCodecRunner(unimplemented);
    expect((await run({ op: 'inflate', chunks: [''], max: 1 })).error).toBe('TypeError');
    expect((await run({ op: 'digest', algs: ['sha256'], chunks: [] })).error).toBe('TypeError');
  });

  it('lists every case once', () => {
    expect(new Set(CODEC_CONTRACT_CASES).size).toBe(CODEC_CONTRACT_CASES.length);
  });
});

describe('codec contract enforcement', () => {
  it('checks completeness in a hook when only backpressure executes', async () => {
    register(async () => ({ pulls: 1 }));
    await registration.cases.get(CODEC_CONTRACT_CASES[2])!();
    expect(registration.hooks).toHaveLength(1);
    expect(() => registration.hooks[0]!()).toThrow();
  });

  for (const closed of [false, true]) {
    it(`observes an aborted readable that ${closed ? 'closes' : 'hangs'}`, async () => {
      const run = await loadCodecRunner({
        ...unimplemented,
        digestTap: () => {
          const digests = Promise.reject(new Error('boom'));
          void digests.catch(() => undefined);
          return {
            digests,
            transform: {
              writable: new WritableStream(),
              readable: new ReadableStream({
                start(controller) {
                  if (closed) controller.close();
                },
              }),
            } as TransformStream<Uint8Array, Uint8Array>,
          };
        },
      });
      const result = await run({ op: 'digestAbort' });
      expect(result).toHaveProperty(
        'readableAfterAbort',
        closed ? { value: { done: true, value: undefined } } : { pending: true },
      );
      register(async (spec) =>
        spec.op === 'digestAbort'
          ? result
          : {
              message: 'source-broke',
              digestsError: 'source-broke',
            },
      );
      await expect(registration.cases.get(CODEC_CONTRACT_CASES[4])!()).rejects.toThrow();
    });
  }

  it('rejects a gunzip adapter that consumes the entire bomb before failing', async () => {
    const run = await loadCodecRunner({
      ...unimplemented,
      gunzip: () =>
        new TransformStream<Uint8Array, Uint8Array>({
          transform() {},
          flush() {
            throw Object.assign(new Error('late limit'), {
              name: 'CodecLimitError',
              operation: 'gunzip',
            });
          },
        }),
    });
    register(run);
    await expect(registration.cases.get(CODEC_CONTRACT_CASES[9])!()).rejects.toThrow();
    register(async () => ({
      error: 'CodecLimitError',
      operation: 'gunzip',
      length: 0,
      inputBytes: 2048,
    }));
    await expect(registration.cases.get(CODEC_CONTRACT_CASES[9])!()).resolves.toBeUndefined();
  });
});
