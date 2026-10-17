import { constants as bufferConstants } from 'node:buffer';
import { createGunzip, inflateSync, type ZlibOptions } from 'node:zlib';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type CodecOperation,
  type Codecs,
  type DigestAlgorithm,
} from '@package-broker/core/platform/codec';

interface DigestStreamLike extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
}

const DIGEST_NAME: Record<DigestAlgorithm, string> = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

function createDigestStream(alg: DigestAlgorithm): DigestStreamLike {
  const factory = (crypto as unknown as { DigestStream?: new (name: string) => DigestStreamLike })
    .DigestStream;
  if (factory === undefined) throw new Error('crypto.DigestStream is unavailable in this runtime');
  return new factory(DIGEST_NAME[alg]);
}

function assertMaxOutput(maxOutput: number): void {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) {
    throw new RangeError('maxOutput must be a non-negative safe integer');
  }
}

function assertExpectedSize(expectedSize: number): void {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new RangeError('expectedSize must be a non-negative safe integer');
  }
}

function digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
  const taps = algs.map((alg) => {
    const stream = createDigestStream(alg);
    return { alg, stream, writer: stream.getWriter() };
  });
  let resolve!: (value: Record<A, Uint8Array>) => void;
  let reject!: (reason: unknown) => void;
  const digests = new Promise<Record<A, Uint8Array>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  digests.catch(() => undefined);
  const abortAll = (reason: unknown) => {
    for (const { writer, stream } of taps) {
      writer.abort(reason).catch(() => undefined);
      stream.digest.catch(() => undefined);
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      try {
        await Promise.all(taps.map(({ writer }) => writer.write(chunk.slice())));
      } catch (error) {
        abortAll(error);
        reject(error);
        throw error;
      }
      controller.enqueue(chunk);
    },
    async flush() {
      try {
        await Promise.all(taps.map(({ writer }) => writer.close()));
        const values = await Promise.all(taps.map(({ stream }) => stream.digest));
        resolve(
          Object.fromEntries(
            taps.map(({ alg }, i) => [alg, new Uint8Array(values[i] as ArrayBuffer)]),
          ) as Record<A, Uint8Array>,
        );
      } catch (error) {
        reject(error);
        throw error;
      }
    },
    cancel(reason) {
      abortAll(reason);
      reject(reason);
    },
  });
  return { transform, digests };
}

function inflateConsumed(input: Uint8Array, maxOutput: number, expectedSize?: number) {
  assertMaxOutput(maxOutput);
  if (expectedSize !== undefined) assertExpectedSize(expectedSize);
  try {
    if (expectedSize !== undefined && expectedSize > maxOutput) {
      throw new CodecLimitError('inflate', maxOutput);
    }
    const limit = expectedSize ?? maxOutput;
    const options: ZlibOptions & { info: true } = {
      info: true,
      maxOutputLength: Math.min(Math.max(1, limit), bufferConstants.MAX_LENGTH),
      ...(expectedSize === undefined ? {} : { chunkSize: Math.max(64, expectedSize + 1) }),
    };
    const { buffer, engine } = inflateSync(input, options) as unknown as {
      buffer: Uint8Array;
      engine: { bytesWritten: number };
    };
    if (buffer.length > limit) throw new CodecLimitError('inflate', maxOutput);
    if (expectedSize !== undefined && buffer.length !== expectedSize) {
      throw new CodecCorruptError('inflate');
    }
    const exact =
      buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.length
        ? new Uint8Array(buffer.buffer, 0, buffer.length)
        : new Uint8Array(buffer);
    return { data: exact, consumed: engine.bytesWritten };
  } catch (error) {
    throw mapZlibError(error, 'inflate', maxOutput);
  }
}

function mapZlibError(error: unknown, operation: CodecOperation, maxOutput: number): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ERR_BUFFER_TOO_LARGE') return new CodecLimitError(operation, maxOutput);
  if (code === 'Z_BUF_ERROR') return new CodecTruncatedError(operation);
  if (code === 'Z_MEM_ERROR') return error;
  if (typeof code === 'string' && code.startsWith('Z_')) return new CodecCorruptError(operation);
  return error;
}

function gunzipTransform(
  engine: ReturnType<typeof createGunzip>,
  maxOutput: number,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const operation: CodecOperation = 'gunzip';
  let produced = 0;
  let fed = 0;
  let failure: unknown;
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const pending = new Set<(reason: unknown) => void>();

  const destroy = (reason: unknown) => {
    engine.destroy();
    for (const settle of [...pending]) settle(reason);
  };

  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    failure = error;
    destroy(error);
    sink.error(error);
  };

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      engine.pause();
      engine.on('data', (data: Buffer) => {
        if (finished) return;
        produced += data.length;
        if (produced > maxOutput) return fail(new CodecLimitError(operation, maxOutput));
        sink.enqueue(new Uint8Array(data));
        if ((sink.desiredSize ?? 0) <= 0) engine.pause();
      });
      engine.on('error', (error) => fail(mapZlibError(error, operation, maxOutput)));
      engine.on('end', () => {
        if (finished) return;
        if (engine.bytesWritten < fed) {
          return fail(new CodecCorruptError(operation));
        }
        finished = true;
        sink.close();
      });
    },
    pull() {
      engine.resume();
    },
    cancel(reason) {
      finished = true;
      destroy(reason);
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (failure) throw failure;
      return new Promise<void>((resolve, reject) => {
        fed += chunk.length;
        const settle = (error?: unknown) => {
          pending.delete(settle);
          if (error) reject(failure ?? error);
          else resolve();
        };
        pending.add(settle);
        engine.write(chunk, settle);
      });
    },
    close() {
      if (failure) throw failure;
      return new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown) => {
          pending.delete(settle);
          if (error) reject(failure ?? error);
          else done();
        };
        const done = () => {
          pending.delete(settle);
          if (failure) reject(failure);
          else resolve();
        };
        pending.add(settle);
        engine.once('finish', done);
        engine.once('close', done);
        engine.end();
      });
    },
    abort(reason) {
      finished = true;
      destroy(reason);
      sink.error(reason);
    },
  });

  return { readable, writable };
}

function deflateRawPair(): ReadableWritablePair<Uint8Array, Uint8Array> {
  const compression = new CompressionStream('deflate-raw');
  const reader = compression.readable.getReader();
  const writer = compression.writable.getWriter();
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  let failed = false;

  const fail = (): CodecCorruptError => {
    const error = new CodecCorruptError('deflate');
    if (!failed) {
      failed = true;
      sink.error(error);
      reader.cancel(error).catch(() => undefined);
    }
    return error;
  };

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (failed) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        fail();
      }
    },
    cancel(reason) {
      failed = true;
      return reader.cancel(reason);
    },
  });

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch {
        throw fail();
      }
    },
    async close() {
      try {
        await writer.close();
      } catch {
        throw fail();
      }
    },
    abort(reason) {
      failed = true;
      sink.error(reason);
      return writer.abort(reason);
    },
  });

  return { readable, writable };
}

export const workersCodecs: Codecs = {
  digestTap,
  inflateConsumed,
  gunzip(maxOutput) {
    assertMaxOutput(maxOutput);
    return gunzipTransform(createGunzip(), maxOutput);
  },
  deflateRaw: deflateRawPair,
};
