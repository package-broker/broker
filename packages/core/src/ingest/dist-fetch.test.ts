import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CatalogueWriteGuard, DistType } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import {
  BlobDigestMismatchError,
  parseSha256,
  type BlobInfo,
  type BlobStore,
} from '../platform/blob.js';
import type { Codecs, DigestAlgorithm } from '../platform/codec.js';
import type { ProviderContext, ProviderSource } from '../sources/provider.js';
import {
  fetchAndVerifyDist,
  type DistFetchDeps,
  type DistFetchTarget,
  type ReplaceBlobRequest,
} from './dist-fetch.js';
import { TwoPassLimitError, UpstreamUnstableError } from './two-pass-put.js';

const ctx = orgContext('01J0ACME000000000000000000');
const guard = [] as unknown as CatalogueWriteGuard;
const enc = new TextEncoder();
const digest = (alg: string, bytes: Uint8Array, enc2: 'hex' | 'base64' = 'hex'): string =>
  createHash(alg).update(bytes).digest(enc2);

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

interface Rig {
  readonly deps: DistFetchDeps;
  readonly events: string[];
  readonly stored: Map<string, Uint8Array>;
  readonly puts: { refetchable: boolean; mediaType: string }[];
  readonly attaches: { versionId: string; revision: number; sha256: string }[];
  readonly replaces: ReplaceBlobRequest[];
  readonly quarantines: { versionId: string; reason: string }[];
  readonly opens: { distType: DistType | null; sourceRef: string | null; url: string | null }[];
  readonly logs: { event: string; reason_code?: unknown }[];
}

function rig(
  bytes: Uint8Array,
  options: {
    sizes?: 'known' | 'unknown';
    declaredSize?: number;
    unchanged?: 'attach' | 'quarantine' | 'replace';
    source?: Partial<ProviderSource> & { type?: string };
    secondBytes?: Uint8Array;
  } = {},
): Rig {
  const events: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const puts: Rig['puts'] = [];
  const attaches: Rig['attaches'] = [];
  const replaces: ReplaceBlobRequest[] = [];
  const quarantines: Rig['quarantines'] = [];
  const opens: Rig['opens'] = [];
  const logs: Rig['logs'] = [];
  const store: BlobStore = {
    async put(_ctx, key, body, input): Promise<BlobInfo> {
      events.push('put');
      puts.push({ refetchable: input.refetchable, mediaType: input.mediaType });
      const got = await drain(body);
      const actual = digest('sha256', got);
      if (actual !== key) throw new BlobDigestMismatchError(key, actual);
      stored.set(key, got);
      return {
        generation: 'test-generation',
        sha256: key,
        size: got.length,
        mediaType: input.mediaType,
        purgeAfter: null,
      };
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
  };
  const source = {
    id: 'src',
    ecosystem: 'composer',
    url: null,
    type: 'packagist_proxy',
    providerId: 'packagist',
    config: {},
    ...options.source,
  } as unknown as ProviderSource;
  const deps: DistFetchDeps = {
    provider: {
      async openDist(_c, _s, target) {
        opens.push({ distType: target.distType, sourceRef: target.sourceRef, url: target.url });
        const body = opens.length % 2 === 0 && options.secondBytes ? options.secondBytes : bytes;
        return {
          body: streamOf(body),
          size: options.declaredSize ?? (options.sizes === 'known' ? body.length : null),
        };
      },
    },
    providerContext: {
      codecs,
      signal: new AbortController().signal,
      observability: {
        log: (record: { event: string; reason_code?: unknown }) => logs.push(record),
        counter: () => undefined,
        histogram: () => undefined,
      },
    } as unknown as ProviderContext,
    source,
    store,
    writer: {
      async attachDist(_c, _g, input) {
        events.push('attach');
        attaches.push({ ...input });
        return { changed: options.unchanged !== 'attach', statements: 3 };
      },
      async quarantine(_c, _g, input) {
        events.push('quarantine');
        quarantines.push({ ...input });
        return { changed: options.unchanged !== 'quarantine', statements: 3 };
      },
    },
    blobReplacer: {
      async replaceBlob(_c, _g, request) {
        events.push('replace');
        replaces.push(request);
        return { changed: options.unchanged !== 'replace', statements: 6 };
      },
    },
    maxBytes: 1024,
  };
  return { deps, events, stored, puts, attaches, replaces, quarantines, opens, logs };
}

const zip = enc.encode('archive bytes');
const sha = (b: Uint8Array) => parseSha256(digest('sha256', b));

function target(extra: Partial<DistFetchTarget> = {}): DistFetchTarget {
  return {
    versionId: 'v1',
    revision: 1,
    packageName: 'acme/pkg',
    version: '1.0.0',
    previousBlob: null,
    fetch: {
      sourceRef: 'abc123',
      upstreamDistUrl: 'https://codeload.example/acme/pkg/zip/abc123',
      distType: 'zip',
      composerShasum: null,
      npmIntegrity: null,
      npmShasum: null,
    },
    ...extra,
  };
}
const withFetch = (fetch: Partial<DistFetchTarget['fetch']>): DistFetchTarget => {
  const t = target();
  return { ...t, fetch: { ...t.fetch, ...fetch } };
};

describe('fetchAndVerifyDist', () => {
  it.each(['attach', 'quarantine', 'replace'] as const)(
    'returns stale without success logs when %s changes nothing',
    async (operation) => {
      const r = rig(zip, { unchanged: operation });
      const t =
        operation === 'quarantine'
          ? withFetch({ npmIntegrity: 'sha512-AAAA' })
          : operation === 'replace'
            ? target({ previousBlob: { id: 'old', sha256: sha(enc.encode('old')) } })
            : target();
      expect(await fetchAndVerifyDist(r.deps, ctx, guard, t)).toBe('stale');
      expect(r.events).toEqual(operation === 'quarantine' ? [operation] : ['put', operation]);
      expect(r.logs).toEqual([]);
    },
  );

  it('refuses a cleanly ended body shorter than its declared size before storage', async () => {
    const r = rig(zip, { declaredSize: zip.length + 1 });
    await expect(fetchAndVerifyDist(r.deps, ctx, guard, target())).rejects.toMatchObject({
      name: 'DistSizeMismatchError',
      message: 'upstream body size differs from declared size',
    });
    expect(r.events).toEqual([]);
    expect(r.stored.size).toBe(0);
    expect(r.opens).toHaveLength(1);
  });

  it('accepts a body matching its declared size', async () => {
    const r = rig(zip, { sizes: 'known' });
    expect(await fetchAndVerifyDist(r.deps, ctx, guard, target())).toBe('attached');
    expect(r.stored.get(sha(zip))).toEqual(zip);
  });

  it('uses application/octet-stream for a null dist type', async () => {
    const r = rig(zip);
    expect(await fetchAndVerifyDist(r.deps, ctx, guard, withFetch({ distType: null }))).toBe(
      'attached',
    );
    expect(r.puts[0]?.mediaType).toBe('application/octet-stream');
    expect(r.opens[0]?.distType).toBeNull();
  });

  it.each([
    ['TwoPassLimitError', TwoPassLimitError],
    ['UpstreamUnstableError', UpstreamUnstableError],
  ] as const)('propagates %s without a catalogue write', async (name, errorClass) => {
    const r = rig(
      zip,
      name === 'UpstreamUnstableError' ? { secondBytes: enc.encode('changed') } : {},
    );
    const deps = name === 'TwoPassLimitError' ? { ...r.deps, maxBytes: zip.length - 1 } : r.deps;
    await expect(fetchAndVerifyDist(deps, ctx, guard, target())).rejects.toBeInstanceOf(errorClass);
    expect(r.attaches).toEqual([]);
    expect(r.replaces).toEqual([]);
    expect(r.quarantines).toEqual([]);
    expect(r.logs).toEqual([]);
    expect(r.stored.size).toBe(0);
  });

  it('stores a body without Content-Length through two passes and attaches it', async () => {
    const r = rig(zip, { sizes: 'unknown' });
    expect(await fetchAndVerifyDist(r.deps, ctx, guard, target())).toBe('attached');
    expect(r.opens).toHaveLength(2);
    expect(r.stored.get(sha(zip))).toEqual(zip);
    expect(r.attaches).toEqual([{ versionId: 'v1', revision: 1, sha256: sha(zip) }]);
    expect(r.events).toEqual(['put', 'attach']);
  });

  it('opens the descriptor ref and type, and stores the media type of the dist type', async () => {
    const r = rig(zip);
    await fetchAndVerifyDist(r.deps, ctx, guard, withFetch({ distType: 'tgz' }));
    expect(r.opens[0]).toMatchObject({ distType: 'tgz', sourceRef: 'abc123' });
    expect(r.puts[0]?.mediaType).toBe('application/gzip');
  });

  it('quarantines an npm tarball whose sha512 differs from integrity and stores nothing', async () => {
    const r = rig(zip);
    const wrong = `sha512-${digest('sha512', enc.encode('other'), 'base64')}`;
    const result = await fetchAndVerifyDist(r.deps, ctx, guard, withFetch({ npmIntegrity: wrong }));
    expect(result).toBe('quarantined');
    expect(r.quarantines).toEqual([{ versionId: 'v1', reason: 'digest_mismatch' }]);
    expect(r.events).toEqual(['quarantine']);
    expect(r.stored.size).toBe(0);
    expect(r.attaches).toEqual([]);
    expect(r.opens).toHaveLength(1);
    expect(r.logs).toEqual([
      expect.objectContaining({ event: 'dist.quarantined', reason_code: 'digest_mismatch' }),
    ]);
  });

  it('attaches when npm integrity, sha1 and the previous sha256 all match', async () => {
    const r = rig(zip);
    const integrity = `sha512-${digest('sha512', zip, 'base64')}`;
    const result = await fetchAndVerifyDist(
      r.deps,
      ctx,
      guard,
      withFetch({ npmIntegrity: integrity, npmShasum: digest('sha1', zip) }),
    );
    expect(result).toBe('attached');
    expect(r.quarantines).toEqual([]);
  });

  it('accepts any entry of a multi-hash integrity and ignores an unsupported algorithm', async () => {
    const r = rig(zip);
    const integrity = `sha384-AAAA sha512-${digest('sha512', zip, 'base64')}`;
    expect(
      await fetchAndVerifyDist(r.deps, ctx, guard, withFetch({ npmIntegrity: integrity })),
    ).toBe('attached');
  });

  it('quarantines an integrity string with no supported algorithm', async () => {
    const r = rig(zip);
    const result = await fetchAndVerifyDist(
      r.deps,
      ctx,
      guard,
      withFetch({ npmIntegrity: 'sha384-AAAA' }),
    );
    expect(result).toBe('quarantined');
    expect(r.stored.size).toBe(0);
  });

  it('prefers the strongest integrity: a bad sha1 entry cannot rescue a bad sha512', async () => {
    const r = rig(zip);
    const integrity = `sha1-${digest('sha1', zip, 'base64')} sha512-${digest('sha512', enc.encode('x'), 'base64')}`;
    expect(
      await fetchAndVerifyDist(r.deps, ctx, guard, withFetch({ npmIntegrity: integrity })),
    ).toBe('quarantined');
  });

  it('quarantines when a Composer shasum differs', async () => {
    const r = rig(zip);
    const result = await fetchAndVerifyDist(
      r.deps,
      ctx,
      guard,
      withFetch({ composerShasum: digest('sha1', enc.encode('other')) }),
    );
    expect(result).toBe('quarantined');
    expect(r.stored.size).toBe(0);
  });

  it('accepts a matching Composer shasum', async () => {
    const r = rig(zip);
    const result = await fetchAndVerifyDist(
      r.deps,
      ctx,
      guard,
      withFetch({ composerShasum: digest('sha1', zip).toUpperCase() }),
    );
    expect(result).toBe('attached');
  });

  it('quarantines when the legacy npm shasum differs and no integrity exists', async () => {
    const r = rig(zip);
    const result = await fetchAndVerifyDist(
      r.deps,
      ctx,
      guard,
      withFetch({ npmShasum: digest('sha1', enc.encode('other')) }),
    );
    expect(result).toBe('quarantined');
  });

  it('treats an empty shasum as unpublished', async () => {
    const r = rig(zip);
    const result = await fetchAndVerifyDist(
      r.deps,
      ctx,
      guard,
      withFetch({ composerShasum: '', npmShasum: '' }),
    );
    expect(result).toBe('attached');
  });

  it('quarantines a differing previous sha256 when a digest was published', async () => {
    const r = rig(zip);
    const other = sha(enc.encode('other'));
    const result = await fetchAndVerifyDist(r.deps, ctx, guard, {
      ...withFetch({ composerShasum: digest('sha1', zip) }),
      previousBlob: { id: 'b1', sha256: other },
    });
    expect(result).toBe('quarantined');
    expect(r.stored.size).toBe(0);
  });

  it('replaces a digestless blob whose bytes changed, as revision R+1 request', async () => {
    const r = rig(zip);
    const old = sha(enc.encode('old bytes'));
    const result = await fetchAndVerifyDist(r.deps, ctx, guard, {
      ...target({ revision: 4 }),
      previousBlob: { id: 'blob-old', sha256: old },
    });
    expect(result).toBe('replaced');
    expect(r.replaces).toEqual([
      {
        versionId: 'v1',
        expectedRevision: 4,
        oldBlobId: 'blob-old',
        newSha256: sha(zip),
        reason: 'refetch_changed',
      },
    ]);
    expect(r.attaches).toEqual([]);
    expect(r.quarantines).toEqual([]);
  });

  it('logs one warning naming both digests when a rebuilt git archive replaces its blob', async () => {
    const r = rig(zip, { source: { type: 'vcs', config: { provider: 'git' } } as never });
    const old = sha(enc.encode('old bytes'));
    const result = await fetchAndVerifyDist(r.deps, ctx, guard, {
      ...target({ revision: 4 }),
      previousBlob: { id: 'blob-old', sha256: old },
    });
    expect(result).toBe('replaced');
    expect(r.logs).toEqual([
      {
        level: 'warn',
        event: 'dist.refetch_changed',
        version_id: 'v1',
        revision: 4,
        previous_sha256_prefix: old.slice(0, 12),
        sha256_prefix: sha(zip).slice(0, 12),
      },
    ]);
  });

  it('puts the bytes before it calls the replace', async () => {
    const r = rig(zip);
    await fetchAndVerifyDist(r.deps, ctx, guard, {
      ...target(),
      previousBlob: { id: 'blob-old', sha256: sha(enc.encode('old bytes')) },
    });
    expect(r.events).toEqual(['put', 'replace']);
  });

  it('re-stores identical bytes for a lost blob and attaches without a replace', async () => {
    const r = rig(zip);
    const result = await fetchAndVerifyDist(r.deps, ctx, guard, {
      ...target(),
      previousBlob: { id: 'blob-old', sha256: sha(zip) },
    });
    expect(result).toBe('attached');
    expect(r.replaces).toEqual([]);
    expect(r.events).toEqual(['put', 'attach']);
  });

  it('marks SSH archives as not refetchable and others, including rebuildable git archives, as refetchable', async () => {
    const built = rig(zip, { source: { type: 'vcs', config: { provider: 'git' } } as never });
    await fetchAndVerifyDist(built.deps, ctx, guard, target());
    const ssh = rig(zip, { source: { type: 'vcs', config: { provider: 'ssh' } } as never });
    await fetchAndVerifyDist(ssh.deps, ctx, guard, target());
    const github = rig(zip, { source: { type: 'vcs', config: { provider: 'github' } } as never });
    await fetchAndVerifyDist(github.deps, ctx, guard, target());
    const proxy = rig(zip);
    await fetchAndVerifyDist(proxy.deps, ctx, guard, target());
    expect(built.puts[0]?.refetchable).toBe(true);
    expect(ssh.puts[0]?.refetchable).toBe(false);
    expect(github.puts[0]?.refetchable).toBe(true);
    expect(proxy.puts[0]?.refetchable).toBe(true);
  });

  it('stores nothing and writes nothing when the upstream bytes change between passes twice', async () => {
    const r = rig(zip, { secondBytes: enc.encode('changed') });
    await expect(fetchAndVerifyDist(r.deps, ctx, guard, target())).rejects.toThrow();
    expect(r.attaches).toEqual([]);
    expect(r.replaces).toEqual([]);
  });

  it('does not call the replace when the put fails', async () => {
    const r = rig(zip);
    const failing: DistFetchDeps = {
      ...r.deps,
      store: {
        ...r.deps.store,
        put: async () => {
          throw new Error('storage down');
        },
      },
    };
    await expect(
      fetchAndVerifyDist(failing, ctx, guard, {
        ...target(),
        previousBlob: { id: 'blob-old', sha256: sha(enc.encode('old bytes')) },
      }),
    ).rejects.toThrow('storage down');
    expect(r.replaces).toEqual([]);
  });

  it('refuses a target without an upstream URL or source ref to fetch from', async () => {
    const r = rig(zip);
    await expect(
      fetchAndVerifyDist(r.deps, ctx, guard, withFetch({ upstreamDistUrl: null, sourceRef: null })),
    ).rejects.toThrow(/no upstream/);
    expect(r.opens).toEqual([]);
  });
});
