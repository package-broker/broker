import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { createDeflateRaw, createGunzip, inflateSync, type ZlibOptions } from 'node:zlib';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type CodecOperation,
  type Codecs,
  type DigestAlgorithm,
} from '@package-broker/core/platform/codec';

function assertMaxOutput(maxOutput: number): void {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) {
    throw new RangeError('maxOutput must be a non-negative safe integer');
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

function digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
  const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
  let resolve!: (value: Record<A, Uint8Array>) => void;
  let reject!: (reason: unknown) => void;
  const digests = new Promise<Record<A, Uint8Array>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  digests.catch(() => undefined);
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const [, hash] of hashes) hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      resolve(
        Object.fromEntries(
          hashes.map(([alg, hash]) => [alg, new Uint8Array(hash.digest())]),
        ) as Record<A, Uint8Array>,
      );
    },
    cancel(reason) {
      reject(reason);
    },
  });
  return { transform, digests };
}

function inflateConsumed(input: Uint8Array, maxOutput: number) {
  assertMaxOutput(maxOutput);
  try {
    const options: ZlibOptions & { info: true } = {
      info: true,
      maxOutputLength: Math.min(Math.max(1, maxOutput), bufferConstants.MAX_LENGTH),
    };
    const { buffer, engine } = inflateSync(input, options) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (buffer.length > maxOutput) throw new CodecLimitError('inflate', maxOutput);
    return { data: new Uint8Array(buffer), consumed: engine.bytesWritten };
  } catch (error) {
    throw mapZlibError(error, 'inflate', maxOutput);
  }
}

function zlibTransform(
  engine: ReturnType<typeof createGunzip>,
  operation: CodecOperation,
  maxOutput: number,
  rejectTrailing: boolean,
): TransformStream<Uint8Array, Uint8Array> {
  let produced = 0;
  let fed = 0;
  let failure: unknown;
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;

  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    failure = error;
    engine.destroy();
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
        if (rejectTrailing && engine.bytesWritten < fed) {
          return fail(new CodecCorruptError(operation));
        }
        finished = true;
        sink.close();
      });
    },
    pull() {
      engine.resume();
    },
    cancel() {
      finished = true;
      engine.destroy();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (failure) throw failure;
      return new Promise<void>((resolve, reject) => {
        fed += chunk.length;
        engine.write(chunk, (error) => (error ? reject(failure ?? error) : resolve()));
      });
    },
    close() {
      if (failure) throw failure;
      return new Promise<void>((resolve, reject) => {
        const done = () => (failure ? reject(failure) : resolve());
        engine.once('finish', done);
        engine.once('close', done);
        engine.end();
      });
    },
    abort(reason) {
      finished = true;
      engine.destroy();
      sink.error(reason);
    },
  });

  return { readable, writable };
}

export const nodeCodecs: Codecs = {
  digestTap,
  inflateConsumed,
  gunzip(maxOutput) {
    assertMaxOutput(maxOutput);
    return zlibTransform(createGunzip(), 'gunzip', maxOutput, true);
  },
  deflateRaw: () => zlibTransform(createDeflateRaw(), 'gunzip', Number.MAX_SAFE_INTEGER, false),
};
