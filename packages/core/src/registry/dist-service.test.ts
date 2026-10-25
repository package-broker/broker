import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as coalesce from '../ingest/coalesce.js';
import type { ProjectActor } from '../authz/project-actor.js';
import type { DistTarget } from '../db/catalogue.js';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import type { OrgId } from '../db/port.js';
import { systemClock } from '../ids.js';
import type { FetchLeaseHandle, FetchLeases } from '../ingest/coalesce.js';
import {
  BlobDigestMismatchError,
  BlobSizeMismatchError,
  parseSha256,
  type BlobInfo,
  type BlobStore,
  type Sha256,
} from '../platform/blob.js';
import type { Codecs, DigestAlgorithm } from '../platform/codec.js';
import {
  ProviderBusyError,
  type ProviderContext,
  type ProviderSource,
} from '../sources/provider.js';
import { createDistService, type DistService, type DistServeResult } from './dist-service.js';

const ORG = 'org_1' as OrgId;
const VERSION = '01J0VERSION00000000000000A';
const enc = new TextEncoder();
const sha = (bytes: Uint8Array): Sha256 =>
  parseSha256(createHash('sha256').update(bytes).digest('hex'));

const actor = (projectId: string): ProjectActor => ({
  kind: 'project',
  userId: 'u1',
  orgId: ORG,
  projectId,
  permissions: new Set(['project:packages:read']),
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

interface RevisionRow {
  blobId: string | null;
}

interface Options {
  initial?: Uint8Array | null;
  integrity?: string | null;
  owner?: string;
  held?: boolean;
  throwOnGet?: boolean;
  refetchable?: boolean;
  upstream?: boolean;
  busyProvider?: boolean;
}

function rig(options: Options = {}) {
  const initial = options.initial === undefined ? enc.encode('v1 bytes') : options.initial;
  const bytes = new Map<string, Uint8Array>();
  const blobs = new Map<string, Sha256>();
  const revisions = new Map<number, RevisionRow>();
  let currentRevision = 1;
  let quarantined = false;
  let upstream: Uint8Array = enc.encode('v1 bytes');
  let gate: Promise<void> | null = null;
  const state = {
    opens: 0,
    signals: [] as AbortSignal[],
    gets: 0,
    heads: 0,
    acquireCalls: 0,
    acquired: [] as FetchLeaseHandle[],
    guarded: [] as FetchLeaseHandle[],
    planned: [] as DistTarget[],
    recorded: [] as string[],
    accessCalls: 0,
    leaseKeys: [] as string[],
  };

  if (initial !== null) {
    const digest = sha(initial);
    blobs.set('blob_1', digest);
    revisions.set(1, { blobId: 'blob_1' });
    bytes.set(digest, initial);
  } else {
    revisions.set(1, { blobId: null });
  }

  let throwOnGet = options.throwOnGet ?? false;
  let throwOnHead = options.throwOnGet ?? false;
  let onAcquire = () => undefined as void;
  const store: BlobStore = {
    async put(_ctx, key, body, input): Promise<BlobInfo> {
      const got = await drain(body);
      const actual = createHash('sha256').update(got).digest('hex');
      if (actual !== key) throw new BlobDigestMismatchError(key, actual);
      bytes.set(key, got);
      return {
        generation: 'test-generation',
        sha256: key,
        size: got.length,
        mediaType: input.mediaType,
        purgeAfter: null,
      };
    },
    async get(_ctx, key) {
      state.gets += 1;
      if (throwOnGet) {
        throwOnGet = false;
        throw new BlobSizeMismatchError();
      }
      const found = bytes.get(key);
      if (found === undefined) return null;
      return {
        info: {
          generation: 'test-generation',
          sha256: key,
          size: found.length,
          mediaType: 'application/zip',
          purgeAfter: null,
        },
        body: streamOf(found),
      };
    },
    async head(_ctx, key) {
      state.heads += 1;
      if (throwOnHead) {
        throwOnHead = false;
        throw new BlobSizeMismatchError();
      }
      const found = bytes.get(key);
      return found === undefined
        ? null
        : {
            generation: 'test-generation',
            sha256: key,
            size: found.length,
            mediaType: 'application/zip',
            purgeAfter: null,
          };
    },
  };

  function target(revision: number): DistTarget | null {
    const row = revisions.get(revision);
    if (row === undefined || quarantined) return null;
    const blobSha = row.blobId === null ? null : (blobs.get(row.blobId) ?? null);
    return {
      versionId: VERSION,
      revision,
      current: revision === currentRevision,
      packageId: 'pkg_1',
      sourceId: 'src_1',
      status: 'active',
      blob:
        row.blobId === null || blobSha === null
          ? null
          : {
              id: row.blobId,
              sha256: blobSha,
              sizeBytes: 1,
              mediaType: 'application/zip',
              refetchable: options.refetchable ?? true,
            },
      fetch: {
        sourceRef: null,
        upstreamDistUrl:
          options.upstream === false ? null : 'https://upstream.example/acme/pkg.zip',
        distType: 'zip',
        composerShasum: null,
        npmIntegrity: options.integrity ?? null,
        npmShasum: null,
      },
    };
  }

  const held = new Set<string>();
  let fence = 0;
  const leases: FetchLeases = {
    async acquire(c, key, owner) {
      state.acquireCalls += 1;
      if (options.held || held.has(`${c.orgId}:${key}`)) return 'held';
      held.add(`${c.orgId}:${key}`);
      fence += 1;
      const handle = { key, owner, fence } satisfies FetchLeaseHandle;
      state.acquired.push(handle);
      onAcquire();
      return handle;
    },
    async renew() {
      return true;
    },
    async release(c, handle) {
      held.delete(`${c.orgId}:${handle.key}`);
    },
  };

  const source = {
    id: 'src_1',
    ecosystem: 'composer',
    url: null,
    type: 'packagist_proxy',
  } as unknown as ProviderSource;
  const deps = {
    provider: {
      async openDist(providerContext: ProviderContext) {
        state.opens += 1;
        state.signals.push(providerContext.signal);
        if (options.busyProvider === true) throw new ProviderBusyError();
        if (gate !== null) await gate;
        return { body: streamOf(upstream), size: null };
      },
    },
    providerContext: {
      codecs,
      signal: new AbortController().signal,
      observability: { log: () => undefined, counter: () => undefined, histogram: () => undefined },
    } as unknown as ProviderContext,
    source,
    store,
    writer: {
      async attachDist(_c: unknown, _g: unknown, input: { revision: number; sha256: Sha256 }) {
        if (revisions.get(input.revision)?.blobId != null) {
          return { changed: false, statements: 0 };
        }
        blobs.set('blob_new', input.sha256);
        revisions.set(input.revision, { blobId: 'blob_new' });
        return { changed: true, statements: 1 };
      },
      async quarantine() {
        quarantined = true;
        return { changed: true, statements: 1 };
      },
    },
    blobReplacer: {
      async replaceBlob(_c: unknown, _g: unknown, request: { newSha256: Sha256 }) {
        blobs.set('blob_2', request.newSha256);
        currentRevision += 1;
        revisions.set(currentRevision, { blobId: 'blob_2' });
        return { changed: true, statements: 1 };
      },
    },
    maxBytes: 1024,
  };

  const newService = (): DistService =>
    createDistService({
      access: {
        async dist(a, _eco, _key, request) {
          state.accessCalls += 1;
          if (a.projectId !== (options.owner ?? 'project_a')) return null;
          if (request.by !== 'id' || request.versionId !== VERSION) return null;
          return target(request.revision);
        },
      },
      store,
      leases,
      clock: systemClock,
      leaseKey: async (parts) => {
        const key = createHash('sha256')
          .update(JSON.stringify(['v1', ...parts]))
          .digest('hex');
        state.leaseKeys.push(key);
        return key;
      },
      writeGuard: (_ctx, handle) => {
        state.guarded.push(handle);
        return [] as unknown as CatalogueWriteGuard;
      },
      planFetch: async (_ctx, target) => {
        state.planned.push(target);
        return { deps: deps as never, packageName: 'acme/pkg', version: '1.0.0' };
      },
      recorder: { record: (_c, id) => void state.recorded.push(id) },
      coalesce: { waitBudgetMs: 150, pollMs: 5 },
    });

  return {
    service: newService(),
    newService,
    attachMissingBlobOnAcquire() {
      onAcquire = () => {
        blobs.set('blob_1', sha(enc.encode('v1 bytes')));
        revisions.set(1, { blobId: 'blob_1' });
      };
    },
    state,
    bytes,
    setUpstream(next: Uint8Array) {
      upstream = next;
    },
    hold(): () => void {
      let open!: () => void;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    },
    setCurrentRevision(revision: number) {
      currentRevision = revision;
    },
    dropBytes(revision: number) {
      const id = revisions.get(revision)?.blobId;
      const digest = id === null || id === undefined ? undefined : blobs.get(id);
      if (digest !== undefined) bytes.delete(digest);
    },
    revisionCount: () => revisions.size,
  };
}

const request = (revision: string | number) => ({
  ecosystem: 'composer' as const,
  key: 'acme/pkg',
  versionId: VERSION,
  revision,
});

const text = async (result: DistServeResult): Promise<string> => {
  if (result.kind !== 'file') throw new Error(`expected file, got ${result.kind}`);
  return new TextDecoder().decode(await drain(result.body));
};

const owner = actor('project_a');

describe('createDistService', () => {
  it('aborts the upstream fetch when the caller signal aborts and rejects the request', async () => {
    const r = rig({ initial: null });
    const open = r.hold();
    const controller = new AbortController();
    const pending = r.service.serve(owner, request(1), { signal: controller.signal });
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.state.signals).toHaveLength(1);
    expect(r.state.signals[0]!.aborted).toBe(false);
    controller.abort(new Error('client gone'));
    expect(r.state.signals[0]!.aborted).toBe(true);
    expect(await settled).toBe('rejected');
    open();
  });

  it('rejects before planning or fetching when the signal is already aborted', async () => {
    const r = rig({ initial: null });
    const controller = new AbortController();
    controller.abort(new Error('client gone'));
    await expect(
      r.service.serve(owner, request(1), { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(r.state.planned).toHaveLength(0);
    expect(r.state.opens).toBe(0);
  });

  it('serves stored bytes without consulting the signal', async () => {
    const r = rig();
    const controller = new AbortController();
    const result = await r.service.serve(owner, request(1), { signal: controller.signal });
    expect(await text(result)).toBe('v1 bytes');
  });

  it('streams live bytes with the immutable download headers and records the access', async () => {
    const r = rig();
    const result = await r.service.serve(owner, request(1));
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') return;
    expect(result.headers.get('Content-Type')).toBe('application/zip');
    expect(result.headers.get('Content-Length')).toBe(String(enc.encode('v1 bytes').length));
    expect(result.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(result.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(await text(result)).toBe('v1 bytes');
    expect(r.state.recorded).toEqual(['blob_1']);
    expect(r.state.opens).toBe(0);
  });

  it('fetches once for two concurrent requests for a missing dist', async () => {
    const r = rig({ initial: null });
    const open = r.hold();
    const first = r.service.serve(owner, request(1));
    const second = r.service.serve(owner, request(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const results = await Promise.all([first, second]);
    expect(r.state.opens).toBe(2); // one fetch = two passes
    expect(await Promise.all(results.map(text))).toEqual(['v1 bytes', 'v1 bytes']);
    expect(new Set(r.state.leaseKeys).size).toBe(1);
    expect(r.state.acquired).toHaveLength(1);
    expect(r.state.guarded).toEqual(r.state.acquired);
    expect(r.state.guarded[0]).toBe(r.state.acquired[0]);
  });

  it('coalesces across service instances sharing leases and catalogue', async () => {
    const r = rig({ initial: null });
    const secondService = r.newService();
    const open = r.hold();
    const first = r.service.serve(owner, request(1));
    const second = secondService.serve(owner, request(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.state.gets).toBe(0);
    open();
    expect(await Promise.all((await Promise.all([first, second])).map(text))).toEqual([
      'v1 bytes',
      'v1 bytes',
    ]);
    expect(r.state.opens).toBe(2);
    expect(r.state.acquired).toHaveLength(1);
    expect(r.state.guarded).toEqual(r.state.acquired);
    expect(r.state.gets).toBe(2);
    expect(r.state.heads).toBeGreaterThan(0);
  });

  it('fills using the target re-resolved after acquiring the lease', async () => {
    const r = rig({ initial: null });
    r.attachMissingBlobOnAcquire();
    r.setUpstream(enc.encode('changed bytes'));
    expect(await r.service.serve(owner, request(1))).toEqual({ kind: 'not_found' });
    expect(r.state.planned[0]?.blob?.id).toBe('blob_1');
    expect(r.revisionCount()).toBe(2);
  });

  it.each(['owner', 'fence'] as const)(
    'preserves the remembered lease when release has a different %s',
    async (field) => {
      const spy = vi.spyOn(coalesce, 'createCoalescer').mockImplementationOnce((leases) => ({
        async run(ctx, key, fill, options) {
          const handle = await leases.acquire(ctx, key, 'current_owner', 60);
          if (handle === 'held') throw new Error('expected acquired lease');
          const stale =
            field === 'owner'
              ? { ...handle, owner: 'old_owner' }
              : { ...handle, fence: handle.fence - 1 };
          await leases.release(ctx, stale);
          await options.isDone();
          try {
            const result = await fill(new AbortController().signal);
            return result === 'pending' ? 'busy' : result;
          } finally {
            await leases.release(ctx, handle);
          }
        },
      }));
      try {
        const r = rig({ initial: null });
        expect(await text(await r.service.serve(owner, request(1)))).toBe('v1 bytes');
        expect(r.state.guarded).toEqual(r.state.acquired);
        expect(r.state.guarded).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('refills a blob whose bytes are unreadable and serves the refilled bytes', async () => {
    const r = rig();
    r.dropBytes(1);
    const result = await r.service.serve(owner, request(1));
    expect(await text(result)).toBe('v1 bytes');
    expect(r.state.opens).toBe(2);
    expect(r.state.gets).toBe(2);
    expect(r.state.heads).toBeGreaterThanOrEqual(2);
    expect(r.state.recorded).toEqual(['blob_1']);
  });

  it('refills when the store throws on read', async () => {
    const r = rig({ throwOnGet: true });
    const result = await r.service.serve(owner, request(1));
    expect(await text(result)).toBe('v1 bytes');
    expect(r.state.opens).toBe(2);
    expect(r.state.gets).toBe(2);
  });

  it('never serves revision R+1 bytes for a request for revision R', async () => {
    const r = rig();
    r.dropBytes(1);
    r.setUpstream(enc.encode('changed bytes'));
    const result = await r.service.serve(owner, request(1));
    expect(result).toEqual({ kind: 'not_found' });
    expect(r.revisionCount()).toBe(2);
    expect(await text(await r.service.serve(owner, request(2)))).toBe('changed bytes');
  });

  it('answers 404 for a historical revision whose bytes are gone, without a fetch', async () => {
    const r = rig();
    r.dropBytes(1);
    r.setUpstream(enc.encode('changed bytes'));
    await r.service.serve(owner, request(1));
    const opens = r.state.opens;
    const acquisitions = r.state.acquireCalls;
    expect(await r.service.serve(owner, request(1))).toEqual({ kind: 'not_found' });
    expect(r.state.opens).toBe(opens);
    expect(r.state.acquireCalls).toBe(acquisitions);
  });

  describe('a non-refetchable blob', () => {
    const observed = () => {
      const log = vi.fn();
      return {
        log,
        observability: { log, counter: vi.fn(), histogram: vi.fn() },
      };
    };
    const event = (revision: number) => ({
      level: 'error',
      event: 'dist.unrefetchable_blob_missing',
      version_id: VERSION,
      revision,
      sha256_prefix: sha(enc.encode('v1 bytes')).slice(0, 12),
    });

    it('answers gone with one event and never plans or opens an upstream dist when its bytes are missing', async () => {
      const r = rig({ refetchable: false });
      r.dropBytes(1);
      const { log, observability } = observed();
      const result = await r.service.serve(owner, request(1), { observability });
      expect(result).toEqual({ kind: 'gone' });
      expect(r.state.opens).toBe(0);
      expect(r.state.planned).toEqual([]);
      expect(r.state.acquireCalls).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(event(1));
    });

    it('answers busy without an event when the store throws on read', async () => {
      const r = rig({ refetchable: false, throwOnGet: true });
      const { log, observability } = observed();
      expect(await r.service.serve(owner, request(1), { observability })).toEqual({
        kind: 'busy',
        retryAfterSeconds: 5,
      });
      expect(r.state.opens).toBe(0);
      expect(r.state.acquireCalls).toBe(0);
      expect(log).not.toHaveBeenCalled();
    });

    it('answers gone for a historical revision whose bytes are missing', async () => {
      const r = rig({ refetchable: false });
      r.dropBytes(1);
      r.setCurrentRevision(2);
      const { log, observability } = observed();
      expect(await r.service.serve(owner, request(1), { observability })).toEqual({
        kind: 'gone',
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(r.state.opens).toBe(0);
    });

    it('keeps the plain 404 for a version without an upstream location', async () => {
      const r = rig({ refetchable: false, upstream: false });
      r.dropBytes(1);
      const { log, observability } = observed();
      expect(await r.service.serve(owner, request(1), { observability })).toEqual({
        kind: 'not_found',
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('answers gone from the fill when the re-resolved target holds a lost non-refetchable blob', async () => {
      const r = rig({ initial: null, refetchable: false });
      r.attachMissingBlobOnAcquire();
      r.bytes.clear();
      const { log, observability } = observed();
      expect(await r.service.serve(owner, request(1), { observability })).toEqual({
        kind: 'gone',
      });
      expect(r.state.opens).toBe(0);
      expect(r.state.planned).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(event(1));
    });

    it('serves its stored bytes without logging', async () => {
      const r = rig({ refetchable: false });
      const { log, observability } = observed();
      expect(await text(await r.service.serve(owner, request(1), { observability }))).toBe(
        'v1 bytes',
      );
      expect(r.state.opens).toBe(0);
      expect(log).not.toHaveBeenCalled();
    });

    it('is still filled on first request when no blob is attached yet', async () => {
      const r = rig({ initial: null, refetchable: false });
      expect(await text(await r.service.serve(owner, request(1)))).toBe('v1 bytes');
      expect(r.state.opens).toBe(2);
    });
  });

  it('answers busy when the provider cannot open the dist yet', async () => {
    const r = rig({ initial: null, busyProvider: true });
    expect(await r.service.serve(owner, request(1))).toEqual({
      kind: 'busy',
      retryAfterSeconds: 5,
    });
    expect(r.state.opens).toBeGreaterThan(0);
  });

  it('answers 404 for a package that is not visible to the project', async () => {
    const r = rig();
    const other = await r.service.serve(actor('project_b'), request(1));
    const absent = await r.service.serve(owner, { ...request(1), versionId: 'NOSUCHVERSION' });
    expect(other).toEqual({ kind: 'not_found' });
    expect(other).toEqual(absent);
    expect(r.state.gets).toBe(0);
    expect(r.state.opens).toBe(0);
    expect(r.state.recorded).toEqual([]);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    '0',
    '-1',
    '1.5',
    'abc',
    '',
    '01',
    ' 1',
    '1e3',
  ])('answers the uniform 404 for revision %j without touching the catalogue', async (revision) => {
    const r = rig();
    expect(await r.service.serve(owner, request(revision))).toEqual({ kind: 'not_found' });
    expect(r.state.accessCalls).toBe(0);
  });

  it.each(['', 'a/b', '..', 'a b', 'x'.repeat(65)])(
    'answers the uniform 404 for version id %j',
    async (versionId) => {
      const r = rig();
      expect(await r.service.serve(owner, { ...request(1), versionId })).toEqual({
        kind: 'not_found',
      });
      expect(r.state.accessCalls).toBe(0);
    },
  );

  it('quarantines on a digest mismatch, stores nothing and answers refused', async () => {
    const r = rig({ initial: null, integrity: `sha512-${'A'.repeat(86)}==` });
    expect(await r.service.serve(owner, request(1))).toEqual({ kind: 'refused' });
    expect(r.bytes.size).toBe(0);
    expect(await r.service.serve(owner, request(1))).toEqual({ kind: 'not_found' });
  });

  it('polls unreadable stored bytes with head without opening response streams', async () => {
    const r = rig({ held: true });
    r.dropBytes(1);
    expect(await r.service.serve(owner, request(1))).toEqual({
      kind: 'busy',
      retryAfterSeconds: 5,
    });
    expect(r.state.heads).toBeGreaterThan(1);
    expect(r.state.gets).toBe(1);
  });

  it('answers busy with Retry-After 5 while another holder fills', async () => {
    const r = rig({ initial: null, held: true });
    expect(await r.service.serve(owner, request(1))).toEqual({
      kind: 'busy',
      retryAfterSeconds: 5,
    });
    expect(r.state.opens).toBe(0);
  });
});

describe('dist refusal on a digest mismatch', () => {
  const WRONG = `sha512-${'A'.repeat(86)}==`;

  it('answers refused to the request that detected it, then the plain 404', async () => {
    const r = rig({ initial: null, integrity: WRONG });
    expect(await r.service.serve(owner, request(1))).toEqual({ kind: 'refused' });
    expect(r.bytes.size).toBe(0);
    expect(await r.service.serve(owner, request(1))).toEqual({ kind: 'not_found' });
    expect(r.state.opens).toBe(1);
  });

  it('answers refused to exactly the caller that ran the fetch, not to coalesced callers', async () => {
    const r = rig({ initial: null, integrity: WRONG });
    const open = r.hold();
    const first = r.service.serve(owner, request(1));
    const second = r.service.serve(owner, request(1));
    await vi.waitFor(() => expect(r.state.opens).toBe(1));
    open();
    const kinds = (await Promise.all([first, second])).map((result) => result.kind);
    expect(kinds.filter((kind) => kind === 'refused')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'not_found')).toHaveLength(1);
    expect(r.state.opens).toBe(1);
  });

  it('keeps the plain 404 for a caller that cannot see the version', async () => {
    const r = rig({ initial: null, integrity: WRONG });
    expect(await r.service.serve(actor('project_b'), request(1))).toEqual({ kind: 'not_found' });
    expect(r.state.opens).toBe(0);
  });

  it('does not refuse an unknown revision', async () => {
    const r = rig({ initial: null });
    expect(await r.service.serve(owner, request(9))).toEqual({ kind: 'not_found' });
  });
});
