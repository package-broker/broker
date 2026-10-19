import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { orgContext } from '@package-broker/core/db/port';
import { applyChunk } from '@package-broker/core/ingest/apply-description';
import { describeNpmPackument } from '@package-broker/core/ingest/npm/packument';
import { parseSha256 } from '@package-broker/core/platform/blob';

// CPU proxy for the two full staged passes in an invocation; fixture construction is excluded.
// Run after pnpm build: node scripts/benchmark-ingest.mjs
// Reference budget only; production CPU accounting must be verified on the target deployment.
const referenceCpuBudgetMs = Number(process.env.PB_INGEST_CPU_BUDGET_MS ?? 30_000);
if (!Number.isFinite(referenceCpuBudgetMs) || referenceCpuBudgetMs <= 0)
  throw new RangeError('invalid CPU reference budget');
const count = 100_000;
const limit = 32 * 1024 * 1024;
const integrity = `sha512-${'A'.repeat(86)}==`;
const versions = Array.from({ length: count }, (_, n) => ({
  version: `1.0.${n}`,
  dist: { integrity, tarball: `https://registry.example.test/pkg/-/pkg-1.0.${n}.tgz` },
  description: '',
}));
const document = () =>
  JSON.stringify({
    name: 'pkg',
    versions: Object.fromEntries(versions.map((v) => [v.version, v])),
  });
const emptySize = Buffer.byteLength(document());
const padding = Math.floor((limit - emptySize) / count);
for (const version of versions) version.description = 'x'.repeat(padding);
versions.at(-1).description += 'x'.repeat(limit - Buffer.byteLength(document()));
const bytes = new TextEncoder().encode(document());
versions.length = 0;
const sha256 = parseSha256(createHash('sha256').update(bytes).digest('hex'));
const snapshot = { id: '"benchmark"', stagedBlob: sha256 };
const ctx = orgContext('benchmark');
const codecs = {
  digestTap(algorithms) {
    const hashes = algorithms.map((algorithm) => [algorithm, createHash(algorithm)]);
    let resolve;
    const digests = new Promise((done) => {
      resolve = done;
    });
    return {
      digests,
      transform: new TransformStream({
        transform(chunk, controller) {
          for (const [, hash] of hashes) hash.update(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          resolve(
            Object.fromEntries(
              hashes.map(([algorithm, hash]) => [algorithm, new Uint8Array(hash.digest())]),
            ),
          );
        },
      }),
    };
  },
};
const store = {
  get: async () => {
    let offset = 0;
    return {
      info: {
        generation: '',
        sha256,
        size: bytes.length,
        mediaType: 'application/json',
        purgeAfter: null,
      },
      body: new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.subarray(offset, offset + 65536));
            offset += 65536;
          }
        },
      }),
    };
  },
};
const guard = [{ sql: 'SELECT 1', params: [] }];
const statementBudget = {
  syncPackage: 500,
  attachDist: 4,
  openListing: 3,
  markListing: 5,
  finalizeListing: 13,
  quarantine: 5,
  markPackageAbsent: 8,
};
const writer = {
  statementBudget,
  syncPayloadLimit: 4 * 1024 * 1024,
  syncPayloadBytes: () => 1,
  syncPackageCost: ({ versions, tags }) => 24 + 4 * versions + 9 * tags,
  syncPackage: async () => ({
    packageId: 'pkg',
    statements: 24,
    refused: [],
    conflicts: [],
    skippedTags: [],
  }),
  markListing: async () => ({ changed: true, statements: 5 }),
};
const measure = (cpu, wall) => {
  const elapsed = process.cpuUsage(cpu);
  return {
    cpuMs: Math.round((elapsed.user + elapsed.system) / 1000),
    wallMs: Math.round(performance.now() - wall),
  };
};
for (const after of [null, count - 1001]) {
  const cpu = process.cpuUsage();
  const wall = performance.now();
  const described = await describeNpmPackument(
    { ctx, store, codecs },
    { name: 'pkg', url: 'https://registry.example.test/pkg' },
    { snapshot },
  );
  if (described.kind !== 'found') throw new Error('benchmark description missing');
  const describeTime = measure(cpu, wall);
  const session = {
    id: 'session',
    scopeKey: 'scope',
    owner: 'owner',
    fence: 1,
    leaseSeconds: 600,
    generation: 1,
    stamp: 'stamp',
    snapshotId: snapshot.id,
    snapshotBlobSha256: sha256,
    seenCount: 0,
    pagesSoFar: 0,
    pendingValidators: null,
    cursor: JSON.stringify({
      packageId: 'pkg',
      ordinal: after,
      attempted: after === null ? 0 : after + 1,
      tail: null,
    }),
  };
  const outcome = await applyChunk(
    ctx,
    {
      writer,
      existing: { existingVersions: async () => ({ rows: [], next: null }) },
      sessions: {
        advance: async (_ctx, held, input) => ({
          seenCount: held.seenCount + input.addSeen,
          pagesSoFar: held.pagesSoFar + 1,
        }),
        abandon: async () => true,
      },
    },
    {
      session,
      guard,
      source: { id: 'source', key: 'pkg', ecosystem: 'npm', type: 'npmjs_proxy', covered: true },
      description: described.description,
      packageDescription: null,
      validatorTtlSeconds: 300,
      toVersion: (candidate) => ({
        version: candidate.version,
        versionNormalized: candidate.version,
        license: null,
        distType: 'tgz',
        sourceRef: null,
        upstreamReleasedAt: null,
        metadata: normalizeVersionMetadata('npm', JSON.parse(candidate.raw)),
        history: { basis: 'release_date', at: '2026-01-01T00:00:00.000Z' },
      }),
    },
  );
  const invocation = measure(cpu, wall);
  console.log(
    JSON.stringify({
      bytes: bytes.length,
      versions: count,
      after,
      describe: describeTime,
      invocation,
      referenceCpuBudgetMs,
      referenceCpuBudgetShare: invocation.cpuMs / referenceCpuBudgetMs,
      status: outcome.status,
      planned: outcome.planned,
    }),
  );
}
