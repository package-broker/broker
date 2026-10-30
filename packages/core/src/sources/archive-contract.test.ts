import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, gzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import {
  fetchAndVerifyDist,
  type DistFetchDeps,
  type DistFetchTarget,
} from '../ingest/dist-fetch.js';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type Codecs,
  type DigestAlgorithm,
} from '../platform/codec.js';
import { npmRoutes } from '../registry/npm/routes.js';
import { forwardNpmAudit, type NpmAuditEntries } from '../registry/npm/audit.js';
import type { RequestContext } from '../plugin.js';
import type { ProviderContext, ProviderSource } from './provider.js';
import { ArchiveError, buildZipFromTree, type ArchiveIo } from './git/archive.js';
import { DeltaError, MAX_DELTA_CHAIN_DEPTH, resolvePackObjects } from './git/delta.js';
import { readFileAtRefs, readTreeAtCommit, type GitFetchContext } from './git/fetch.js';
import { DELIM, FLUSH, encodePkt } from './git/pkt-line.js';
import { PackBudget, PackBudgetError, parsePackObjects, type ParsedPack } from './git/pack.js';
import { createPolicyFetch } from './policy-fetch.js';
import { createOutboundPolicy } from './url-policy.js';

const enc = new TextEncoder();
const MIB = 1024 * 1024;

const nodeCodecs: Codecs = {
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
          Object.fromEntries(hashes.map(([a, h]) => [a, new Uint8Array(h.digest())])) as never,
        );
      },
      cancel(reason) {
        settle.reject(reason);
      },
    });
    return { transform, digests };
  },
  inflateConsumed(input, maxOutput) {
    try {
      const { buffer, engine } = inflateSync(input, {
        info: true,
        maxOutputLength: maxOutput + 1,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (buffer.length > maxOutput) throw new CodecLimitError('inflate', maxOutput);
      return { data: new Uint8Array(buffer), consumed: engine.bytesWritten };
    } catch (e) {
      if (e instanceof CodecLimitError) throw e;
      const code = (e as { code?: string }).code;
      if (code === 'ERR_BUFFER_TOO_LARGE') throw new CodecLimitError('inflate', maxOutput);
      if (code === 'Z_BUF_ERROR') throw new CodecTruncatedError('inflate');
      throw new CodecCorruptError('inflate');
    }
  },
  gunzip(maxOutput) {
    const inner = new DecompressionStream('gzip');
    let total = 0;
    const limit = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.length;
        if (total > maxOutput) throw new CodecLimitError('gunzip', maxOutput);
        controller.enqueue(chunk);
      },
    });
    return { writable: inner.writable, readable: inner.readable.pipeThrough(limit) };
  },
  deflateRaw: () => {
    throw new Error('unused');
  },
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sizeVarint(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  while (rest >= 128) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Uint8Array.from(bytes);
}

function ofsVarint(distance: number): Uint8Array {
  const bytes = [distance & 0x7f];
  let d = Math.floor(distance / 128);
  while (d > 0) {
    d -= 1;
    bytes.unshift(0x80 | (d & 0x7f));
    d = Math.floor(d / 128);
  }
  return Uint8Array.from(bytes);
}

function copyOp(offset: number, size: number): number[] {
  const bytes: number[] = [];
  let op = 0x80;
  for (let i = 0; i < 4; i++) {
    const b = Math.floor(offset / 2 ** (8 * i)) & 0xff;
    if (b) {
      op |= 1 << i;
      bytes.push(b);
    }
  }
  for (let i = 0; i < 3; i++) {
    const b = (size >> (8 * i)) & 0xff;
    if (b) {
      op |= 0x10 << i;
      bytes.push(b);
    }
  }
  return [op, ...bytes];
}

const delta = (baseSize: number, resultSize: number, ops: number[]): Uint8Array =>
  Uint8Array.from([...sizeVarint(baseSize), ...sizeVarint(resultSize), ...ops]);

interface PackEntry {
  readonly data: Uint8Array;
  readonly ofsBase?: number;
  readonly declaredSize?: number;
  readonly cutStreamBy?: number;
}

function buildPack(entries: readonly PackEntry[], count = entries.length): Uint8Array {
  const header = new Uint8Array(12);
  header.set(enc.encode('PACK'));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, count);
  const parts: Uint8Array[] = [header];
  const starts: number[] = [];
  let at = header.length;
  for (const e of entries) {
    starts.push(at);
    const size = e.declaredSize ?? e.data.length;
    const piece =
      e.ofsBase === undefined
        ? [objectHeader(3, size)]
        : [objectHeader(6, size), ofsVarint(at - (starts[e.ofsBase] as number))];
    const stream = new Uint8Array(deflateSync(e.data));
    piece.push(stream.subarray(0, stream.length - (e.cutStreamBy ?? 0)));
    const bytes = concat(piece);
    parts.push(bytes);
    at += bytes.length;
  }
  const body = concat(parts);
  return concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
}

const limits = { maxObjects: 50_000, maxRetainedBytes: MIB, maxObjectBytes: 64 * 1024 };
const newBudget = (over: Partial<typeof limits> = {}) => new PackBudget({ ...limits, ...over });

async function resolveAll(pack: Uint8Array, budget = newBudget()): Promise<void> {
  const parsed: ParsedPack = await parsePackObjects(pack, nodeCodecs, budget);
  await resolvePackObjects(parsed, nodeCodecs, budget);
}

describe('hostile pack contract', () => {
  const baseText = enc.encode('0123456789');

  it('refuses a delta copy that reaches past its base', async () => {
    const pack = buildPack([{ data: baseText }, { data: delta(10, 8, copyOp(6, 8)), ofsBase: 0 }]);
    await expect(resolveAll(pack)).rejects.toMatchObject({
      name: 'DeltaError',
      code: 'copy_out_of_range',
    });
  });

  it('refuses a delta chain of depth 51', async () => {
    expect(MAX_DELTA_CHAIN_DEPTH).toBe(50);
    const entries: PackEntry[] = [{ data: baseText }];
    for (let i = 1; i <= 51; i++) {
      entries.push({ data: delta(10, 10, copyOp(0, 10)), ofsBase: i - 1 });
    }
    await expect(resolveAll(buildPack(entries))).rejects.toMatchObject({
      name: 'DeltaError',
      code: 'chain_too_deep',
    });
  });

  it.each([
    ['larger than the data', 5],
    ['smaller than the data', -3],
  ])('refuses an object whose declared size is %s', async (_label, skew) => {
    const pack = buildPack([{ data: baseText, declaredSize: baseText.length + skew }]);
    await expect(parsePackObjects(pack, nodeCodecs, newBudget())).rejects.toMatchObject({
      name: 'PackFormatError',
      code: 'size_mismatch',
    });
  });

  it('refuses a pack whose trailer does not match its contents', async () => {
    const pack = buildPack([{ data: baseText }]);
    pack[pack.length - 1] = (pack[pack.length - 1] as number) ^ 0xff;
    await expect(parsePackObjects(pack, nodeCodecs, newBudget())).rejects.toMatchObject({
      name: 'PackFormatError',
      code: 'trailer_mismatch',
    });
  });

  it('refuses a pack that declares more objects than it carries', async () => {
    const pack = buildPack([{ data: baseText }], 2);
    await expect(parsePackObjects(pack, nodeCodecs, newBudget())).rejects.toMatchObject({
      name: 'PackFormatError',
      code: 'truncated',
    });
  });

  it('refuses an object whose deflate stream ends early, from the inflater with a valid trailer', async () => {
    const pack = buildPack([{ data: baseText, cutStreamBy: 4 }]);
    const inflate = vi.spyOn(nodeCodecs, 'inflateConsumed');
    try {
      await expect(parsePackObjects(pack, nodeCodecs, newBudget())).rejects.toMatchObject({
        name: 'PackFormatError',
        code: 'truncated',
      });
      expect(inflate).toHaveBeenCalledTimes(1);
      expect(inflate.mock.results[0]).toMatchObject({ type: 'throw' });
      expect(inflate.mock.results[0]?.value).toBeInstanceOf(CodecTruncatedError);
    } finally {
      inflate.mockRestore();
    }
  });

  describe('aggregate retained budget', () => {
    const OBJECT = 60 * 1024;
    const COPIES = 20;
    const pack = (): Uint8Array => {
      const data = new Uint8Array(randomBytes(OBJECT));
      return buildPack([
        { data },
        ...Array.from({ length: COPIES }, () => ({
          data: delta(OBJECT, OBJECT, copyOp(0, OBJECT)),
          ofsBase: 0,
        })),
      ]);
    };

    it('refuses delta outputs that together cross maxRetainedBytes', async () => {
      expect(OBJECT).toBeLessThan(limits.maxObjectBytes);
      expect(OBJECT * COPIES).toBeGreaterThan(limits.maxRetainedBytes);
      const rejection = await resolveAll(pack()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(rejection).toBeInstanceOf(PackBudgetError);
      expect(rejection).toMatchObject({ code: 'retained_bytes' });
    });

    it('resolves the same pack when the retained budget is large enough', async () => {
      await expect(resolveAll(pack(), newBudget({ maxRetainedBytes: 8 * MIB }))).resolves.toBe(
        undefined,
      );
    });
  });

  it('keeps DeltaError a distinct typed error', () => {
    expect(new DeltaError('bad_opcode')).toMatchObject({ name: 'DeltaError', code: 'bad_opcode' });
  });
});

describe('hostile tree path contract', () => {
  const COMMIT = '0123456789abcdef0123456789abcdef01234567';
  const OID = 'a'.repeat(40);

  function attempt(path: string) {
    const reads = vi.fn();
    const created = vi.fn();
    const forbidden = () => {
      throw new Error('codec must not run');
    };
    const io: ArchiveIo = {
      blobs: { read: reads },
      staging: { create: created },
    };
    const run = buildZipFromTree(
      {
        commit: COMMIT,
        committedAt: '2024-01-01T00:00:00Z',
        entries: [{ path, mode: '100644', type: 'blob', oid: OID }],
        skipped: 0,
      },
      { digestTap: forbidden, deflateRaw: forbidden },
      io,
    );
    return { run, reads, created };
  }

  it.each([
    ['a parent traversal', '../evil.txt'],
    ['an embedded parent traversal', 'src/../../evil.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'src\\evil.txt'],
    ['a NUL byte', 'src/evil\0.txt'],
    ['a 1,025-byte path', `${'a'.repeat(1024)}b`],
  ])('refuses %s with bad_path and touches no blob or staging file', async (_label, path) => {
    const { run, reads, created } = attempt(path);
    await expect(run).rejects.toBeInstanceOf(ArchiveError);
    await expect(run).rejects.toMatchObject({ code: 'bad_path' });
    expect(reads).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });
});

describe('git fetch contract', () => {
  const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
  const RESULT = 'application/x-git-upload-pack-result';
  const url = 'https://contract.example.com/acme/lib.git';

  function fetchContext(response: () => Response, runtime: GitFetchContext['runtime']) {
    const inner = createPolicyFetch({
      policy,
      userAgent: 'package-broker-test',
      fetchImpl: async () => response(),
    });
    return { policyFetch: inner, codecs: nodeCodecs, runtime } satisfies GitFetchContext;
  }

  function gitObject(type: 'blob' | 'tree' | 'commit', data: Uint8Array) {
    const oid = createHash('sha1')
      .update(enc.encode(`${type} ${data.length}\0`))
      .update(data)
      .digest('hex');
    return { type: { commit: 1, tree: 2, blob: 3 }[type], data, oid };
  }

  function packResponse(objects: ReturnType<typeof gitObject>[]): Uint8Array {
    const header = new Uint8Array(12);
    header.set(enc.encode('PACK'));
    const view = new DataView(header.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, objects.length);
    const body = concat([
      header,
      ...objects.flatMap((o) => [
        objectHeader(o.type, o.data.length),
        new Uint8Array(deflateSync(o.data)),
      ]),
    ]);
    const pack = concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
    const bands: Uint8Array[] = [];
    for (let at = 0; at < pack.length; at += 65_000) {
      bands.push(encodePkt(concat([Uint8Array.of(1), pack.subarray(at, at + 65_000)])));
    }
    return concat([encodePkt('shallow-info\n'), DELIM, encodePkt('packfile\n'), ...bands, FLUSH]);
  }

  it('refuses a tree of 20,001 entries with tree_too_large', async () => {
    const blob = gitObject('blob', enc.encode('x'));
    const tree = gitObject(
      'tree',
      concat(
        Array.from({ length: 20_001 }, (_, n) =>
          concat([
            enc.encode(`100644 f${String(n).padStart(6, '0')}\0`),
            Uint8Array.from(Buffer.from(blob.oid, 'hex')),
          ]),
        ),
      ),
    );
    const commit = gitObject(
      'commit',
      enc.encode(
        `tree ${tree.oid}\nauthor A <a@example.com> 1700000000 +0000\n` +
          'committer A <a@example.com> 1700000000 +0000\n\nrelease\n',
      ),
    );
    const body = packResponse([blob, tree, commit]);
    const context = fetchContext(
      () => new Response(body, { headers: { 'content-type': RESULT } }),
      'docker',
    );
    await expect(readTreeAtCommit(context, url, commit.oid)).rejects.toMatchObject({
      name: 'GitFetchError',
      code: 'tree_too_large',
    });
  });

  describe('Workers pack cap', () => {
    const CAP = 16 * MIB;
    const PACKET = 65_005;
    const response = (total: number) => {
      const parts: Uint8Array[] = [encodePkt('packfile\n')];
      let remaining = total - 13 - FLUSH.length;
      while (remaining > 0) {
        let take = Math.min(PACKET, remaining);
        if (remaining - take > 0 && remaining - take < 5) take -= 5;
        parts.push(encodePkt(concat([Uint8Array.of(1), new Uint8Array(take - 5)])));
        remaining -= take;
      }
      parts.push(FLUSH);
      const body = concat(parts);
      expect(body.length).toBe(total);
      return new Response(body, { headers: { 'content-type': RESULT } });
    };
    const read = (total: number, runtime: GitFetchContext['runtime']) =>
      readFileAtRefs(
        fetchContext(() => response(total), runtime),
        url,
        [{ name: 'refs/tags/v1', oid: 'b'.repeat(40) }],
        'composer.json',
      );

    it('refuses a response one byte above 16 MiB with too_large', async () => {
      await expect(read(CAP + 1, 'cloudflare')).rejects.toMatchObject({ code: 'too_large' });
    });

    it('does not report too_large for a response of exactly 16 MiB', async () => {
      await expect(read(CAP, 'cloudflare')).rejects.toMatchObject({ code: 'bad_response' });
    });

    it('applies the larger Docker cap to the same response', async () => {
      await expect(read(CAP + 1, 'docker')).rejects.toMatchObject({ code: 'bad_response' });
    });
  });
});

describe('dist body cap contract', () => {
  const ctx = orgContext('01J0ACME000000000000000000');
  const guard = [] as unknown as CatalogueWriteGuard;
  const CAP = 1024;

  function rig(size: number | null, endless: boolean) {
    const events: string[] = [];
    let pulls = 0;
    const deps = {
      provider: {
        async openDist() {
          return {
            size,
            body: new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1;
                if (!endless && pulls > 4) controller.close();
                else controller.enqueue(new Uint8Array(512).fill(1));
              },
            }),
          };
        },
      },
      providerContext: {
        codecs: nodeCodecs,
        signal: new AbortController().signal,
        observability: {
          log: () => undefined,
          counter: () => undefined,
          histogram: () => undefined,
        },
      } as unknown as ProviderContext,
      source: { id: 's', type: 'packagist_proxy', config: {} } as unknown as ProviderSource,
      store: {
        async stage() {
          throw new Error('not_implemented');
        },
        async openStaged() {
          throw new Error('not_implemented');
        },
        async promote() {
          throw new Error('not_implemented');
        },
        async discard() {
          throw new Error('not_implemented');
        },

        put: async () => {
          events.push('put');
          throw new Error('unreachable');
        },
        get: async () => null,
        head: async () => null,
      },
      writer: {
        attachDist: async () => {
          events.push('attach');
          return { changed: true, statements: 1 };
        },
        quarantine: async () => {
          events.push('quarantine');
          return { changed: true, statements: 1 };
        },
      },
      blobReplacer: {
        replaceBlob: async () => {
          events.push('replace');
          return { changed: true, statements: 1 };
        },
      },
      maxBytes: CAP,
    } as unknown as DistFetchDeps;
    return { deps, events, pulls: () => pulls };
  }

  const target: DistFetchTarget = {
    versionId: 'v1',
    revision: 1,
    packageName: 'acme/pkg',
    version: '1.0.0',
    previousBlob: null,
    fetch: {
      sourceRef: null,
      upstreamDistUrl: 'https://codeload.example/acme/pkg.zip',
      distType: 'zip',
      composerShasum: null,
      npmIntegrity: null,
      npmShasum: null,
    },
  };

  it('quarantines a body above the cap that declares its length and stores nothing', async () => {
    const r = rig(4 * CAP, false);
    expect(await fetchAndVerifyDist(r.deps, ctx, guard, target)).toBe('quarantined');
    expect(r.events).toEqual(['quarantine']);
  });

  it('quarantines a body above the cap without a declared length and stops reading', async () => {
    const r = rig(null, true);
    expect(await fetchAndVerifyDist(r.deps, ctx, guard, target)).toBe('quarantined');
    expect(r.events).toEqual(['quarantine']);
    expect(r.pulls()).toBeLessThan(16);
  });
});

describe('npm audit gzip bomb contract', () => {
  it('refuses a body that inflates past the decompressed cap before classifying or forwarding', async () => {
    const classifyWinners = vi.fn();
    const hasAttachedProxy = vi.fn();
    const authorizeNpmAudit = vi.fn();
    const policyFetch = vi.fn();
    const forward = vi.fn((entries: NpmAuditEntries, ctx: RequestContext) =>
      forwardNpmAudit(entries, ctx.request, ctx.org!, ctx.projectId!, ctx.requestId, {
        classifyWinners,
        hasAttachedProxy,
        authorizeNpmAudit,
        policyFetch,
        observability: { log: vi.fn() },
      }),
    );
    const versions = vi.fn();
    const serve = vi.fn();
    const ensure = vi.fn();
    const reresolve = vi.fn();
    const route = npmRoutes({
      access: {
        versions,
        list: vi.fn(),
        dist: vi.fn(),
        resolve: vi.fn(),
        version: vi.fn(),
        tag: vi.fn(),
        distTags: vi.fn(),
        search: vi.fn(),
      },
      dist: { serve },
      onDemand: { ensure },
      reresolve,
      handleOf: () => null,
      publicUrl: 'https://broker.test',
      codecs: nodeCodecs,
      audit: { enabled: true, forward },
    }).find((route) => route.path.endsWith('/security/advisories/bulk'))!;
    const response = await route.handler({
      request: new Request('https://broker.test/project/npm/-/npm/v1/security/advisories/bulk', {
        method: 'POST',
        body: gzipSync(Buffer.alloc(64 * MIB, 0x20)),
        headers: { 'content-encoding': 'gzip' },
      }),
      requestId: 'request',
      org: orgContext('org-a'),
      principal: null,
      projectId: 'project',
      params: {},
      ports: {} as RequestContext['ports'],
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'payload_too_large' });
    expect(versions).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(reresolve).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(classifyWinners).not.toHaveBeenCalled();
    expect(hasAttachedProxy).not.toHaveBeenCalled();
    expect(authorizeNpmAudit).not.toHaveBeenCalled();
    expect(policyFetch).not.toHaveBeenCalled();
  });
});
