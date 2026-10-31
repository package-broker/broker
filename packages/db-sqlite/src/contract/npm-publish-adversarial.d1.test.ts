import { createHash } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { describeNpmPublishAdversarial } from './npm-publish-adversarial.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { migrate } from '../migrations/runner.js';

// The test host supplies Workers stream primitives; D1 and R2 remain real Miniflare bindings.
const originalDigest = Object.getOwnPropertyDescriptor(crypto, 'DigestStream');
beforeAll(() => {
  class Digest extends WritableStream<Uint8Array> {
    readonly digest: Promise<ArrayBuffer>;
    constructor() {
      const hash = createHash('sha256');
      let resolve!: (value: ArrayBuffer) => void;
      let reject!: (reason: unknown) => void;
      const digest = new Promise<ArrayBuffer>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      super({
        write(chunk) {
          hash.update(chunk);
        },
        close() {
          resolve(Uint8Array.from(hash.digest()).buffer);
        },
        abort: reject,
      });
      this.digest = digest;
    }
  }
  Object.defineProperty(crypto, 'DigestStream', { value: Digest, configurable: true });
});
afterAll(() => {
  if (originalDigest) Object.defineProperty(crypto, 'DigestStream', originalDigest);
  else Reflect.deleteProperty(crypto, 'DigestStream');
});

describeNpmPublishAdversarial('D1', async () => {
  const require = createRequire(
    new URL('../../../runtime-cloudflare/package.json', import.meta.url),
  );
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['NPMADVERSARIAL'],
      r2Buckets: ['BLOBS'],
    }),
  );
  try {
    const module = '@package-broker/runtime-cloudflare/db/d1-executor';
    const { createD1Executor } = await import(module);
    const executor: SqlExecutor = createD1Executor(await mf.getD1Database('NPMADVERSARIAL'));
    await migrate(executor, await discoveredMigrations(), { holder: 'npm-publish-adversarial' });
    const adapter = '@package-broker/runtime-cloudflare/blob/r2';
    const { createR2ByteStore } = await import(adapter);
    const binding = await mf.getR2Bucket('BLOBS');
    // Node cannot tag a native FixedLengthStream; materialize only these tiny fixture uploads.
    const bucket = {
      get: binding.get.bind(binding),
      head: binding.head.bind(binding),
      delete: binding.delete.bind(binding),
      list: binding.list.bind(binding),
      createMultipartUpload: binding.createMultipartUpload.bind(binding),
      put: async (key: string, value: unknown, options?: unknown) =>
        binding.put(
          key,
          value instanceof ReadableStream
            ? new Uint8Array(await new Response(value).arrayBuffer())
            : value,
          options,
        ),
    };
    return {
      executor,
      bytes: createR2ByteStore(bucket, {
        fixedLengthStream: () => new TransformStream<Uint8Array, Uint8Array>(),
      }),
      close: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
});
