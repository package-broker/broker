import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { openFilesystemByteStore } from './blob/filesystem.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNpmVcsBuildJob } from '@package-broker/core/ingest/npm-vcs-build-job';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createCatalogueWriter } from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createCatalogueWriteGuard } from '@package-broker/db-sqlite/repositories/catalogue-write-package';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { nodeCodecs } from './codec/node-codec.js';
const stream = (bytes: Uint8Array) => new Blob([Uint8Array.from(bytes)]).stream();
function entry(path: string, body: string): Uint8Array {
  const encoder = new TextEncoder(),
    content = encoder.encode(body),
    bytes = new Uint8Array(512 + Math.ceil(content.length / 512) * 512);
  const put = (at: number, text: string) => bytes.set(encoder.encode(text), at);
  put(0, path);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, content.length.toString(8).padStart(11, '0') + '\0');
  put(136, '00000000000\0');
  put(156, '0');
  put(257, 'ustar\0');
  put(263, '00');
  bytes.fill(32, 148, 156);
  put(
    148,
    bytes
      .subarray(0, 512)
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
  );
  bytes.set(content, 512);
  return bytes;
}
function archive(...entries: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(entries.reduce((n, entry) => n + entry.length, 1024));
  let at = 0;
  for (const entry of entries) {
    bytes.set(entry, at);
    at += entry.length;
  }
  return bytes;
}
import { orgContext } from '@package-broker/core/db/port';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { StagedBlob } from '@package-broker/core/platform/blob';
import { parseSha256 } from '@package-broker/core/platform/blob';
import {
  buildNpmVcsDist,
  type DistFetchDeps,
  type DistFetchTarget,
} from '@package-broker/core/ingest/dist-fetch';
const ctx = orgContext('org');
const guard = [] as unknown as CatalogueWriteGuard;
const commit = 'a'.repeat(40);
const target: DistFetchTarget = {
  versionId: 'V',
  revision: 1,
  packageName: 'fixture',
  version: '1.0.0',
  previousBlob: null,
  fetch: {
    distType: 'tgz',
    sourceRef: commit,
    upstreamDistUrl: null,
    npmIntegrity: null,
    npmShasum: null,
    composerShasum: null,
  },
};
function setup() {
  const bytes = gzipSync(
    archive(
      entry('repo/package.json', '{"name":"fixture","version":"1.0.0"}'),
      entry('repo/README.md', '# readme'),
      entry('repo/a.js', 'a'),
    ),
  );
  const staged = new Map<string, Uint8Array>();
  let next = 0;
  const attachDist = vi.fn().mockResolvedValue({ changed: true });
  const discard = vi.fn(async (_ctx, blob: StagedBlob) => {
    staged.delete(blob.handle);
  });
  const promote = vi.fn(async (_ctx, blob: StagedBlob) => ({
    ...blob,
    generation: 'generation',
    purgeAfter: null,
  }));
  const deps = {
    source: {
      id: 'S',
      type: 'vcs',
      ecosystem: 'npm',
      url: null,
      config: { provider: 'github', repository: 'owner/repo', refs: { tags: true, branches: [] } },
    },
    providerContext: { codecs: nodeCodecs, signal: new AbortController().signal },
    provider: { openDist: vi.fn().mockResolvedValue({ body: stream(bytes), size: bytes.length }) },
    store: {
      stage: vi.fn(async (_ctx, body, input) => {
        const content = new Uint8Array(await new Response(body).arrayBuffer());
        if (content.length > input.maxBytes) throw new Error('cap');
        const handle = String(++next);
        staged.set(handle, content);
        return {
          handle,
          size: content.length,
          mediaType: input.mediaType,
          sha256: parseSha256(createHash('sha256').update(content).digest('hex')),
        };
      }),
      openStaged: vi.fn(async (_ctx, blob: StagedBlob) => stream(staged.get(blob.handle)!)),
      promote,
      discard,
    },
    writer: { attachDist },
    maxBytes: 50_000_000,
  } as unknown as DistFetchDeps;
  return { deps, attachDist, discard, promote };
}
describe('npm VCS build dist', () => {
  it('stages, repacks, hashes and attaches a non-refetchable blob and readme under the lease guard', async () => {
    const h = setup();
    expect(await buildNpmVcsDist(h.deps, ctx, guard, target)).toBe('attached');
    expect(h.promote).toHaveBeenCalledWith(ctx, expect.anything(), { refetchable: false });
    expect(h.attachDist).toHaveBeenCalledWith(
      ctx,
      guard,
      expect.objectContaining({
        versionId: 'V',
        revision: 1,
        expectedGeneration: 'generation',
        npmIntegrity: expect.stringMatching(/^sha512-/),
        readme: { filename: 'README.md', body: '# readme' },
      }),
    );
    expect(h.discard).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      'unsupported pattern',
      '{"name":"fixture","version":"1.0.0","files":["+(a)"]}',
      'ok',
      50000000,
      'unsupported_files_pattern',
    ],
    [
      'invalid packlist',
      '{"name":"fixture","version":"1.0.0","files":false}',
      'ok',
      50000000,
      'invalid_packlist',
    ],
    ['output cap', '{"name":"fixture","version":"1.0.0"}', 'ok', 1, 'invalid_packlist'],
    [
      'README controls',
      '{"name":"fixture","version":"1.0.0"}',
      '\x00',
      50000000,
      'invalid_packlist',
    ],
  ] as const)(
    'ends the job without retry and reports %s',
    async (_label, manifest, readme, maxBytes, code) => {
      const h = setup();
      const bytes = gzipSync(
        archive(entry('repo/package.json', manifest), entry('repo/README.md', readme)),
      );
      vi.mocked(h.deps.provider.openDist).mockResolvedValue({
        size: bytes.length,
        body: stream(bytes),
      });
      const reportSkipped = vi.fn();
      const job = createNpmVcsBuildJob({
        plan: async () => ({ deps: { ...h.deps, maxBytes, reportSkipped }, target, guard }),
      });
      await job.handler(
        job.validate({ sourceId: 'S', packageId: 'P', versionId: 'V', version: '1.0.0' }),
        {
          org: ctx,
          signal: new AbortController().signal,
          fences: jobFences({ id: 'J', owner: 'worker', fence: 1 }),
        } as JobContext,
      );
      expect(reportSkipped).toHaveBeenCalledExactlyOnceWith(code);
      expect(h.attachDist).not.toHaveBeenCalled();
    },
  );
  it('stores the selected README path and its truncation marker', async () => {
    const h = setup();
    const bytes = gzipSync(
      archive(
        entry('repo/package.json', '{"name":"fixture","version":"1.0.0"}'),
        entry('repo/README.z', 'z'.repeat(524289)),
        entry('repo/README.a', 'a'),
      ),
    );
    vi.mocked(h.deps.provider.openDist).mockResolvedValue({
      size: bytes.length,
      body: stream(bytes),
    });
    await buildNpmVcsDist(h.deps, ctx, guard, target);
    expect(h.attachDist).toHaveBeenCalledWith(
      ctx,
      guard,
      expect.objectContaining({
        readme: { filename: 'README.z', body: 'z'.repeat(524288) },
        readmeTruncated: true,
      }),
    );
  });
  it('keeps the promotion error with a real CoreBlobStore after its handle is consumed', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true });
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'pb-npm-vcs-'));
    const failure = new Error('promotion failed');
    try {
      const bytes = await openFilesystemByteStore({ root: directory });
      const store = createBlobStore(
        {
          ...bytes,
          promote: async () => {
            throw failure;
          },
        },
        createBlobRepository(database.executor),
        { admission: createBlobUploadAdmission(), maxBytes: 64 * 1024 * 1024 },
      );
      const discard = vi.fn(store.discard);
      const tracked = { ...store, discard };
      const h = setup();
      await expect(
        buildNpmVcsDist({ ...h.deps, store: tracked }, database.orgs!.a, guard, target),
      ).rejects.toBe(failure);
      expect(discard).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('two concurrent builds promote distinct blobs and the losing CAS leaves the winning row intact', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    const run = (sql: string, ...params: (string | number)[]) =>
      database.executor.batch([{ sql, params }]);
    try {
      await run(
        "INSERT INTO source (id,org_id,name,ecosystem,type) VALUES ('S',?,'fixture','npm','vcs')",
        org.orgId,
      );
      await run(
        "INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES ('K',?,'S','npm','fixture')",
        org.orgId,
      );
      await run(
        "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json,dist_type,source_ref) VALUES ('V',?,'K','1.0.0','1.0.0','2026-01-01T00:00:00.000Z','broker','{}','tgz',?)",
        org.orgId,
        commit,
      );
      await run(
        "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('J',?,'core:npm-vcs-build:v1','build','running','worker','2999-01-01T00:00:00.000Z',1)",
        org.orgId,
      );
      const lease = createCatalogueWriteGuard(org, { id: 'J', owner: 'worker', fence: 1 });
      const builds = [setup(), setup()];
      const different = gzipSync(
        archive(
          entry('repo/package.json', '{"name":"fixture","version":"1.0.0"}'),
          entry('repo/README.md', '# other build'),
        ),
      );
      vi.mocked(builds[1]!.deps.provider.openDist).mockResolvedValue({
        size: different.length,
        body: stream(different),
      });
      let promotions = 0;
      let release!: () => void;
      const bothPromoted = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const [index, h] of builds.entries()) {
        h.promote.mockImplementation(async (_ctx, blob: StagedBlob) => {
          await run(
            "INSERT INTO blob (id,org_id,sha256,size_bytes,storage_key,refetchable,purge_generation) VALUES (?,?,?,?,?,0,'cccccccccccccccccccccccccccccccc')",
            String(index),
            org.orgId,
            blob.sha256,
            blob.size,
            'npm-publish/' + index,
          );
          if (++promotions === 2) release();
          await bothPromoted;
          return { ...blob, generation: 'cccccccccccccccccccccccccccccccc', purgeAfter: null };
        });
      }
      const outcomes = await Promise.allSettled(
        builds.map((h) =>
          buildNpmVcsDist(
            { ...h.deps, writer: createCatalogueWriter(database.executor) },
            org,
            lease,
            target,
          ),
        ),
      );
      expect(
        outcomes.filter((r) => r.status === 'fulfilled'),
        outcomes.map((r) => (r.status === 'rejected' ? String(r.reason) : r.value)).join('; '),
      ).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rejected = outcomes.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
        kind: 'unique',
        constraint: 'access_mutation_guard.key',
      });
      const winner = outcomes[0]!.status === 'fulfilled' ? '0' : '1';
      expect(
        await database.executor.all({
          sql: "SELECT blob_id,revision FROM version WHERE org_id=? AND id='V'",
          params: [org.orgId],
        }),
      ).toEqual([{ blob_id: winner, revision: 1 }]);
      expect(
        await database.executor.all({
          sql: "SELECT rev FROM package WHERE org_id=? AND id='K'",
          params: [org.orgId],
        }),
      ).toEqual([{ rev: 2 }]);
      expect(
        await database.executor.all({
          sql: 'SELECT id FROM blob WHERE org_id=? ORDER BY id',
          params: [org.orgId],
        }),
      ).toEqual([{ id: '0' }, { id: '1' }]);
      for (const h of builds) expect(h.discard).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });
  it('retains the packed handle once promotion starts and preserves its error', async () => {
    const h = setup();
    h.promote.mockRejectedValue(new Error('unavailable'));
    await expect(buildNpmVcsDist(h.deps, ctx, guard, target)).rejects.toThrow('unavailable');
    expect(h.discard).toHaveBeenCalledTimes(1);
    expect(h.attachDist).not.toHaveBeenCalled();
  });
  it('rejects declared repository size over 64 MiB before staging', async () => {
    const h = setup();
    vi.mocked(h.deps.provider.openDist).mockResolvedValue({
      body: stream(new Uint8Array()),
      size: 64 * 1024 * 1024 + 1,
    });
    await expect(buildNpmVcsDist(h.deps, ctx, guard, target)).rejects.toThrow();
    expect(h.deps.store.stage).not.toHaveBeenCalled();
  });
});

describe('generic Git npm archive', () => {
  it('streams files and long paths, skips symlinks, and honours export-ignore', async () => {
    const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
    const { walkRepositoryTarball } =
      await import('@package-broker/core/registry/npm/tarball-walk');
    const contents: Record<string, string> = {
      attrs: 'hidden export-ignore\n',
      short: 'x',
      long: 'long',
      hidden: 'hidden',
    };
    const long = 'd/' + 'a'.repeat(110);
    const tree = {
      commit,
      committedAt: '2026-01-01T00:00:00Z',
      skipped: 0,
      entries: [
        { path: '.gitattributes', oid: 'attrs', mode: '100644', type: 'blob' as const },
        { path: 'short', oid: 'short', mode: '100755', type: 'blob' as const },
        { path: long, oid: 'long', mode: '100644', type: 'blob' as const },
        { path: 'hidden', oid: 'hidden', mode: '100644', type: 'blob' as const },
        { path: 'link', oid: 'link', mode: '120000', type: 'blob' as const },
      ],
    };
    const read = vi.fn(async (oid: string) => {
      const bytes = new TextEncoder().encode(contents[oid]);
      return { size: bytes.length, body: stream(bytes) };
    });
    const gzip = await gitTarball(tree, { read }, nodeCodecs, new AbortController().signal);
    const paths: string[] = [];
    await walkRepositoryTarball(gzip.pipeThrough(nodeCodecs.gunzip(1024 * 1024)), async (entry) => {
      paths.push(entry.path);
    });
    expect(paths).toEqual(['.gitattributes', 'short', long]);
    expect(read.mock.calls.map(([oid]) => oid)).not.toContain('link');
    expect(read.mock.calls.map(([oid]) => oid)).not.toContain('hidden');
  });
  it.each([
    '../escape',
    'a//b',
    'a/./b',
    'a\\b',
    'a\u0000b',
    'd/'.repeat(65) + 'a',
    'a'.repeat(4097),
  ])('refuses an invalid or over-limit Git path', async (path) => {
    const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
    const tree = {
      commit,
      committedAt: '',
      skipped: 0,
      entries: [{ path, oid: 'blob', mode: '100644', type: 'blob' as const }],
    };
    const gzip = await gitTarball(
      tree,
      { read: async () => ({ size: 0, body: stream(new Uint8Array()) }) },
      nodeCodecs,
      new AbortController().signal,
    );
    await expect(new Response(gzip).arrayBuffer()).rejects.toThrow('invalid_git_path');
  });
  it('caps tree entries and refuses incomplete trees before opening bodies', async () => {
    const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
    const read = vi.fn();
    await expect(
      gitTarball(
        { commit, committedAt: '', entries: [], skipped: 1 },
        { read },
        nodeCodecs,
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid_git_tree');
    await expect(
      gitTarball(
        { commit, committedAt: '', entries: Array(50001).fill({}), skipped: 0 },
        { read },
        nodeCodecs,
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid_git_tree');
    expect(read).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid declared blob size %s',
    async (size) => {
      const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
      const gzip = await gitTarball(
        {
          commit,
          committedAt: '',
          skipped: 0,
          entries: [{ path: 'a', oid: 'blob', mode: '100644', type: 'blob' }],
        },
        { read: async () => ({ size, body: stream(new Uint8Array()) }) },
        nodeCodecs,
        new AbortController().signal,
      );
      await expect(new Response(gzip).arrayBuffer()).rejects.toThrow('too_large');
    },
  );
  it('caps cumulative Git bytes across individually bounded blobs', async () => {
    const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
    let opened = 0;
    const gzip = await gitTarball(
      {
        commit,
        committedAt: '',
        skipped: 0,
        entries: ['a', 'b'].map((path) => ({
          path,
          oid: path,
          mode: '100644',
          type: 'blob' as const,
        })),
      },
      {
        read: async (_oid, maxBytes) => {
          opened++;
          expect(maxBytes).toBe(opened === 1 ? 64 * 1024 * 1024 : 0);
          const size = opened === 1 ? 64 * 1024 * 1024 : 1;
          return {
            size,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                for (let i = 0; i < size; i += 1024 * 1024)
                  controller.enqueue(new Uint8Array(Math.min(1024 * 1024, size - i)));
                controller.close();
              },
            }),
          };
        },
      },
      nodeCodecs,
      new AbortController().signal,
    );
    await expect(new Response(gzip).arrayBuffer()).rejects.toThrow('too_large');
    expect(opened).toBe(2);
  });
  it('refuses a body exceeding its declared Git blob length', async () => {
    const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
    const gzip = await gitTarball(
      {
        commit,
        committedAt: '',
        skipped: 0,
        entries: [{ path: 'a', oid: 'blob', mode: '100644', type: 'blob' }],
      },
      { read: async () => ({ size: 1, body: stream(new Uint8Array(2)) }) },
      nodeCodecs,
      new AbortController().signal,
    );
    await expect(new Response(gzip).arrayBuffer()).rejects.toThrow('git_blob_size');
  });
  it('caps retained Git bytes and verifies each blob length', async () => {
    const { gitTarball } = await import('@package-broker/core/ingest/vcs/git-tar');
    const tree = {
      commit,
      committedAt: '',
      skipped: 0,
      entries: [{ path: 'a', oid: 'blob', mode: '100644', type: 'blob' as const }],
    };
    for (const size of [64 * 1024 * 1024 + 1, 2]) {
      const gzip = await gitTarball(
        tree,
        { read: async () => ({ size, body: stream(new Uint8Array(1)) }) },
        nodeCodecs,
        new AbortController().signal,
      );
      await expect(new Response(gzip).arrayBuffer()).rejects.toThrow(
        size === 2 ? 'git_blob_size' : 'too_large',
      );
    }
  });
});
