import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../authz/project-actor.js';
import type { CatalogueWriteGuard, DistTarget, FetchDescriptor } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { systemClock } from '../ids.js';
import { parseSha256, type BlobStore, type Sha256 } from '../platform/blob.js';
import type { Codecs, DigestAlgorithm } from '../platform/codec.js';
import type { ProviderContext, ProviderSource } from '../sources/provider.js';
import { createDistService, type DistServeResult } from '../registry/dist-service.js';
import type { FetchLeaseHandle } from './coalesce.js';
import type { DistFetchDeps } from './dist-fetch.js';

const ctx = orgContext('01J0ACME000000000000000000');
const actor: ProjectActor = {
  kind: 'project',
  userId: 'u1',
  orgId: ctx.orgId,
  projectId: 'project1',
  permissions: new Set(['project:packages:read']),
};
const enc = new TextEncoder();
const original = enc.encode('original archive');
const changed = enc.encode('replacement archive');
const hash = (algorithm: string, bytes: Uint8Array, encoding: 'hex' | 'base64' = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const sha = (bytes: Uint8Array): Sha256 => parseSha256(hash('sha256', bytes));
const request = (revision: string | number = 1) => ({
  ecosystem: 'composer' as const,
  key: 'acme/pkg',
  versionId: 'VERSION1',
  revision,
});

const codecs: Pick<Codecs, 'digestTap'> = {
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
    const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
    let settle!: { resolve(v: never): void; reject(e: unknown): void };
    const digests = new Promise<Record<A, Uint8Array>>((resolve, reject) => {
      settle = { resolve: resolve as (v: never) => void, reject };
    });
    digests.catch(() => undefined);
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const [, h] of hashes) h.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        settle.resolve(
          Object.fromEntries(hashes.map(([alg, h]) => [alg, new Uint8Array(h.digest())])) as never,
        );
      },
      cancel(reason) {
        settle.reject(reason);
      },
    });
    return { transform, digests };
  },
};

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (done) controller.close();
      else {
        done = true;
        controller.enqueue(bytes);
      }
    },
  });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

function rig(
  options: { attached?: boolean; historical?: boolean; fetch?: Partial<FetchDescriptor> } = {},
) {
  const bytes = new Map<Sha256, Uint8Array>();
  const rows = new Map<number, Sha256 | null>([[1, options.attached ? sha(original) : null]]);
  let current = options.historical ? 2 : 1;
  let quarantined = false;
  let beforePut = () => {};
  let upstream = original;
  const logs = vi.fn();
  const attaches = vi.fn();
  const replacements = vi.fn();
  const quarantine = vi.fn();
  const opens = vi.fn(async () => ({ body: streamOf(upstream), size: null }));
  const store: BlobStore = {
    async put(_ctx, key, body, input) {
      const value = await drain(body);
      expect(sha(value)).toBe(key);
      beforePut();
      bytes.set(key, value);
      return {
        generation: 'test-generation',
        sha256: key,
        size: value.length,
        mediaType: input.mediaType,
        purgeAfter: null,
      };
    },
    async head(_ctx, key) {
      const value = bytes.get(key);
      return value === undefined
        ? null
        : {
            generation: 'test-generation',
            sha256: key,
            size: value.length,
            mediaType: 'application/zip',
            purgeAfter: null,
          };
    },
    async get(c, key) {
      const info = await store.head(c, key);
      return info === null ? null : { info, body: streamOf(bytes.get(key)!) };
    },
  };
  const fetch: FetchDescriptor = {
    sourceRef: null,
    upstreamDistUrl: 'https://upstream.example/archive.zip',
    distType: 'zip',
    composerShasum: null,
    npmIntegrity: null,
    npmShasum: null,
    ...options.fetch,
  };
  const resolve = vi.fn(
    async (
      a: ProjectActor,
      _eco: unknown,
      key: string,
      query: { by: string; versionId?: string; revision?: number },
    ): Promise<DistTarget | null> => {
      if (
        a.orgId !== ctx.orgId ||
        a.projectId !== actor.projectId ||
        key !== 'acme/pkg' ||
        quarantined ||
        query.versionId !== 'VERSION1'
      )
        return null;
      const revision = query.revision!;
      const digest = rows.get(revision);
      if (digest === undefined) return null;
      return {
        versionId: 'VERSION1',
        revision,
        current: revision === current,
        packageId: 'package1',
        sourceId: 'source1',
        status: 'active',
        fetch,
        blob:
          digest === null
            ? null
            : {
                id: `blob${revision}`,
                sha256: digest,
                sizeBytes: original.length,
                mediaType: 'application/zip',
                refetchable: true,
              },
      };
    },
  );
  const deps: DistFetchDeps = {
    provider: { openDist: opens },
    providerContext: {
      codecs,
      signal: new AbortController().signal,
      observability: { log: logs, counter: () => {}, histogram: () => {} },
    } as unknown as ProviderContext,
    source: {
      id: 'source1',
      ecosystem: 'composer',
      type: 'packagist_proxy',
      config: {},
    } as unknown as ProviderSource,
    store,
    writer: {
      async attachDist(c, guard, input) {
        attaches(c, guard, input);
        if (quarantined || input.revision !== current || rows.get(current) !== null)
          return { changed: false, statements: 0 };
        rows.set(current, input.sha256);
        return { changed: true, statements: 1 };
      },
      async quarantine(c, guard, input) {
        quarantine(c, guard, input);
        quarantined = true;
        return { changed: true, statements: 1 };
      },
    },
    blobReplacer: {
      async replaceBlob(c, guard, input) {
        replacements(c, guard, input);
        if (quarantined || input.expectedRevision !== current)
          return { changed: false, statements: 0 };
        rows.set(++current, input.newSha256);
        return { changed: true, statements: 1 };
      },
    },
    maxBytes: 1024,
  };
  const leases = new Map<string, FetchLeaseHandle>();
  const guard = [] as unknown as CatalogueWriteGuard;
  const service = createDistService({
    access: { dist: resolve },
    store,
    clock: systemClock,
    leases: {
      async acquire(c, key, owner) {
        const scoped = `${c.orgId}:${key}`;
        if (leases.has(scoped)) return 'held';
        const handle = { key, owner, fence: 1 };
        leases.set(scoped, handle);
        return handle;
      },
      async renew() {
        return true;
      },
      async release(c, handle) {
        leases.delete(`${c.orgId}:${handle.key}`);
      },
    },
    leaseKey: async (parts) => hash('sha256', enc.encode(JSON.stringify(parts))),
    writeGuard: () => guard,
    planFetch: async () => ({ deps, packageName: 'acme/pkg', version: '1.0.0' }),
    recorder: { record: vi.fn() },
    coalesce: { waitBudgetMs: 200, pollMs: 1 },
  });
  return {
    service,
    bytes,
    rows,
    opens,
    logs,
    attaches,
    replacements,
    quarantine,
    resolve,
    guard,
    changeUpstream() {
      upstream = changed;
    },
    quarantineBeforeAttach() {
      beforePut = () => {
        quarantined = true;
      };
    },
  };
}

async function body(result: DistServeResult) {
  expect(result.kind).toBe('file');
  if (result.kind !== 'file') throw new Error('expected archive');
  return drain(result.body);
}

// A3 merge confirmation is required by the task packet for attached-blob recovery.
const attachedRecovery = describe.skip;
attachedRecovery('lost attached bytes (A3 confirmation pending)', () => {
  it('recovers identical bytes without changing the revision', async () => {
    const r = rig({ attached: true });
    expect(await body(await r.service.serve(actor, request()))).toEqual(original);
    expect(r.rows.size).toBe(1);
    expect(r.replacements).not.toHaveBeenCalled();
    expect(r.opens).toHaveBeenCalledTimes(2);
  });

  it('makes empty-shasum changes a logged revision and preserves the pinned URL', async () => {
    const r = rig({ attached: true, fetch: { composerShasum: '' } });
    r.changeUpstream();
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'not_found' });
    expect(r.replacements).toHaveBeenCalledWith(ctx, r.guard, {
      versionId: 'VERSION1',
      expectedRevision: 1,
      oldBlobId: 'blob1',
      newSha256: sha(changed),
      reason: 'refetch_changed',
    });
    expect(await body(await r.service.serve(actor, request(2)))).toEqual(changed);
    const opens = r.opens.mock.calls.length;
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'not_found' });
    expect(r.opens).toHaveBeenCalledTimes(opens);
    expect(r.logs).toHaveBeenCalled();
  });

  it('quarantines a previous SHA-256 mismatch even when the published shasum matches', async () => {
    const r = rig({ attached: true, fetch: { composerShasum: hash('sha1', changed) } });
    r.changeUpstream();
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'not_found' });
    expect(r.quarantine).toHaveBeenCalledWith(ctx, r.guard, {
      versionId: 'VERSION1',
      reason: 'digest_mismatch',
    });
    expect(r.bytes.size).toBe(0);
    expect(r.replacements).not.toHaveBeenCalled();
  });
});

describe('re-mirror and quarantine contract', () => {
  it.each([
    { composerShasum: hash('sha1', changed) },
    { npmShasum: hash('sha1', changed) },
    { npmIntegrity: `sha512-${hash('sha512', changed, 'base64')}` },
  ])('quarantines and reports a published digest mismatch: %j', async (fetch) => {
    const r = rig({ fetch });
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'refused' });
    expect(r.quarantine).toHaveBeenCalledWith(ctx, r.guard, {
      versionId: 'VERSION1',
      reason: 'digest_mismatch',
    });
    expect(r.logs).toHaveBeenCalledWith({
      level: 'warn',
      event: 'dist.quarantined',
      reason_code: 'digest_mismatch',
      source_id: 'source1',
      package_key: 'acme/pkg',
    });
    expect(r.bytes.size).toBe(0);
    expect(r.attaches).not.toHaveBeenCalled();
    expect(r.replacements).not.toHaveBeenCalled();
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'not_found' });
    expect(r.opens).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent requests into one two-pass fetch', async () => {
    const r = rig();
    const results = await Promise.all([
      r.service.serve(actor, request()),
      r.service.serve(actor, request()),
    ]);
    expect(await Promise.all(results.map(body))).toEqual([original, original]);
    expect(r.opens).toHaveBeenCalledTimes(2);
    expect(r.attaches).toHaveBeenCalledTimes(1);
  });

  it('does not attach or serve bytes when quarantine wins between fetch and attach', async () => {
    const r = rig();
    r.quarantineBeforeAttach();
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'not_found' });
    expect(r.attaches).toHaveBeenCalledTimes(1);
    expect(r.rows.get(1)).toBeNull();
    expect(r.replacements).not.toHaveBeenCalled();
  });

  it('never refetches a historical revision with blob null', async () => {
    const r = rig({ historical: true });
    expect(await r.service.serve(actor, request())).toEqual({ kind: 'not_found' });
    expect(r.opens).not.toHaveBeenCalled();
    expect(r.attaches).not.toHaveBeenCalled();
  });

  it.each(['0', 'not-a-number'])(
    'rejects revision %s before catalogue resolution with the uniform result',
    async (revision) => {
      const r = rig();
      const malformed = await r.service.serve(actor, request(revision));
      expect(r.resolve).not.toHaveBeenCalled();
      const invisible = await r.service.serve({ ...actor, projectId: 'other' }, request());
      const absent = await r.service.serve(actor, { ...request(), versionId: 'ABSENT' });
      expect(JSON.stringify(malformed)).toBe(JSON.stringify(invisible));
      expect(JSON.stringify(malformed)).toBe(JSON.stringify(absent));
      expect(malformed).toEqual({ kind: 'not_found' });
      expect(r.opens).not.toHaveBeenCalled();
    },
  );
});
