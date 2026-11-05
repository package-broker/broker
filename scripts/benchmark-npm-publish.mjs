// Run after pnpm typecheck: node scripts/benchmark-npm-publish.mjs
// Stages are isolated wall/CPU measurements, not additive pipeline timings or Workers billing.
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { scanPublishBody } from '../packages/core/dist/registry/npm/publish-body.js';
import { walkTarball } from '../packages/core/dist/registry/npm/tarball-walk.js';
import { entry, join, stream } from '../packages/core/dist/test-support/npm-publish.js';
import { nodeCodecs } from '../packages/runtime-node/dist/codec/node-codec.js';

const count = 48_000;
const parts = [
  entry('package/package.json', JSON.stringify({ name: 'test-package', version: '1.0.0' })),
];
let seed = 123456789;
for (let i = 1; i < count; i++) {
  const file = entry(`package/file-${i}`, '', '0', 724);
  const bytes = new Uint8Array(1024);
  for (let j = 0; j < 724; j++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[j] = seed & 255;
  }
  parts.push(join(file, bytes));
}
parts.push(new Uint8Array(1024));
const tar = join(...parts);
parts.length = 0;
const tgz = gzipSync(tar);
const body = new TextEncoder().encode(
  JSON.stringify({
    name: 'test-package',
    versions: { '1.0.0': { name: 'test-package', version: '1.0.0' } },
    _attachments: {
      'test-package-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length },
    },
  }),
);
console.log(
  JSON.stringify({
    node: process.version,
    entries: count,
    bodyBytes: body.length,
    gzipBytes: tgz.length,
    tarBytes: tar.length,
  }),
);
async function measure(stage, task) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  await task();
  const used = process.cpuUsage(cpu);
  console.log(
    JSON.stringify({
      stage,
      wallMs: +(performance.now() - start).toFixed(2),
      cpuMs: +((used.user + used.system) / 1000).toFixed(2),
    }),
  );
}
for (let run = 1; run <= 3; run++) {
  let decoded = 0;
  await measure(`decode-${run}`, () =>
    scanPublishBody(stream(body, 65536), {
      name: 'test-package',
      onTarballChunk: async (bytes) => {
        decoded += bytes.length;
      },
    }),
  );
  if (decoded !== tgz.length) throw new Error('benchmark decode size mismatch');
  await measure(`digest-${run}`, async () => {
    const tap = nodeCodecs.digestTap(['sha1', 'sha256', 'sha512']);
    await stream(tgz, 16384).pipeThrough(tap.transform).pipeTo(new WritableStream());
    await tap.digests;
  });
  await measure(`gunzip-${run}`, async () => {
    await stream(tgz, 16384)
      .pipeThrough(nodeCodecs.gunzip(256 * 1024 * 1024))
      .pipeTo(new WritableStream());
  });
  await measure(`walk-${run}`, async () => {
    const result = await walkTarball(stream(tar, 16384), {
      name: 'test-package',
      version: '1.0.0',
    });
    if (result.fileCount !== count) throw new Error('benchmark entry count mismatch');
  });
}
