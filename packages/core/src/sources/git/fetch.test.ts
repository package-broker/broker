import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type Codecs,
  type DigestAlgorithm,
} from '../../platform/codec.js';
import {
  UpstreamError,
  createPolicyFetch,
  type PolicyFetch,
  type UpstreamRequest,
} from '../policy-fetch.js';
import { createOutboundPolicy } from '../url-policy.js';
import {
  createFilterStrategyCache,
  readFileAtRefs,
  MAX_WANTS_PER_REQUEST,
  readTreeAtCommit,
  type GitFetchContext,
} from './fetch.js';
import { GitRemoteError, FLUSH, DELIM, encodePkt } from './pkt-line.js';

const enc = new TextEncoder();
const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const RESULT = 'application/x-git-upload-pack-result';

const codecs: Codecs = {
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
    const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
    let resolveDigests!: (v: Record<A, Uint8Array>) => void;
    const digests = new Promise<Record<A, Uint8Array>>((resolve) => {
      resolveDigests = resolve;
    });
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const [, h] of hashes) h.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        resolveDigests(
          Object.fromEntries(hashes.map(([a, h]) => [a, new Uint8Array(h.digest())])) as Record<
            A,
            Uint8Array
          >,
        );
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
  gunzip: () => {
    throw new Error('unused');
  },
  deflateRaw: () => {
    throw new Error('unused');
  },
};

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const sha1 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};

interface Obj {
  type: 'commit' | 'tree' | 'blob';
  data: Uint8Array;
  oid: string;
  stored?: boolean;
}

function makeObj(type: Obj['type'], data: Uint8Array, stored = false): Obj {
  return {
    type,
    data,
    oid: sha1(enc.encode(`${type} ${data.length}\0`), data).toString('hex'),
    ...(stored ? { stored } : {}),
  };
}

function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

const MIB = 1024 * 1024;
const bigBlob = once(() => makeObj('blob', new Uint8Array(9 * MIB).fill(0x61)));
const incompressibleBlob = once(() => makeObj('blob', new Uint8Array(randomBytes(17 * MIB)), true));
const manifestBlobs = new Map<number, Obj>();
function manifestBlob(n: number): Obj {
  let blob = manifestBlobs.get(n);
  if (!blob) {
    blob = makeObj('blob', enc.encode(String.fromCharCode(65 + n).repeat(900 * 1024)));
    manifestBlobs.set(n, blob);
  }
  return blob;
}
const bigBlobsByFill = new Map<number, Obj>();
function bigBlobFilled(fill: number): Obj {
  let blob = bigBlobsByFill.get(fill);
  if (!blob) {
    blob = makeObj('blob', new Uint8Array(9 * MIB).fill(fill));
    bigBlobsByFill.set(fill, blob);
  }
  return blob;
}

interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

function makeTree(items: TreeItem[]): Obj {
  return makeObj(
    'tree',
    concat(
      items.map((i) =>
        concat([enc.encode(`${i.mode} ${i.name}\0`), Uint8Array.from(Buffer.from(i.oid, 'hex'))]),
      ),
    ),
  );
}

function makeCommit(tree: string, when = 1_700_000_000, zone = '+0200'): Obj {
  return makeObj(
    'commit',
    enc.encode(
      `tree ${tree}\nauthor Dev One <dev@example.com> ${when} ${zone}\n` +
        `committer Dev One <dev@example.com> ${when} ${zone}\n\nrelease\n`,
    ),
  );
}

const TYPE_CODE = { commit: 1, tree: 2, blob: 3 } as const;

function packHeader(type: number, size: number): Uint8Array {
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

const deflated = new WeakMap<Obj, Uint8Array>();
function deflateObj(o: Obj): Uint8Array {
  let out = deflated.get(o);
  if (!out) {
    out = new Uint8Array(deflateSync(o.data, o.stored ? { level: 0 } : {}));
    deflated.set(o, out);
  }
  return out;
}

function buildPack(objects: Obj[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(enc.encode('PACK'));
  const dv = new DataView(header.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  const body = concat([
    header,
    ...objects.flatMap((o) => [packHeader(TYPE_CODE[o.type], o.data.length), deflateObj(o)]),
  ]);
  return concat([body, new Uint8Array(sha1(body))]);
}

const SMALL_BAND = 97;
const LARGE_BAND = 65_000;
const LARGE_PACK = 256 * 1024;

function fetchResponse(pack: Uint8Array): Uint8Array {
  const bands: Uint8Array[] = [];
  const step = pack.length > LARGE_PACK ? LARGE_BAND : SMALL_BAND;
  for (let at = 0; at < pack.length; at += step) {
    bands.push(encodePkt(concat([Uint8Array.of(1), pack.subarray(at, at + step)])));
  }
  return concat([
    encodePkt('shallow-info\n'),
    DELIM,
    encodePkt('packfile\n'),
    encodePkt(concat([Uint8Array.of(2), enc.encode('Counting objects\n')])),
    ...bands,
    FLUSH,
  ]);
}

function errResponse(text = 'filter not supported'): Uint8Array {
  return encodePkt(`ERR ${text}\n`);
}

interface Wire {
  wants: string[];
  filter: string | undefined;
  deepen: string | undefined;
  lines: string[];
}

function parseRequest(body: Uint8Array): Wire {
  const lines: string[] = [];
  let at = 0;
  while (at < body.length) {
    const len = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
    if (len < 4) {
      at += 4;
      continue;
    }
    lines.push(new TextDecoder().decode(body.subarray(at + 4, at + len)).trimEnd());
    at += len;
  }
  return {
    lines,
    wants: lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5)),
    filter: lines.find((l) => l.startsWith('filter '))?.slice(7),
    deepen: lines.find((l) => l.startsWith('deepen '))?.slice(7),
  };
}

class FakeGit {
  readonly objects = new Map<string, Obj>();
  readonly requests: Wire[] = [];
  readonly seen: UpstreamRequest[] = [];
  rejected = new Set<string>();
  httpStatus: Map<string, number> = new Map();
  dropFromPacks = new Set<string>();
  errorText = 'filter not supported';
  override: (() => Response) | undefined;

  add(obj: Obj): Obj {
    this.objects.set(obj.oid, obj);
    return obj;
  }

  private closure(oid: string, filter: string | undefined, root: boolean): Obj[] {
    const obj = this.objects.get(oid);
    if (!obj || this.dropFromPacks.has(oid)) return [];
    if (!root && filter === 'blob:none' && obj.type === 'blob') return [];
    const out = [obj];
    if (obj.type === 'commit') {
      const treeOid = /^tree ([0-9a-f]{40})/.exec(new TextDecoder().decode(obj.data))?.[1] ?? '';
      if (filter === 'tree:0') return out;
      out.push(...this.closure(treeOid, filter, false));
    } else if (obj.type === 'tree' && (filter === undefined || filter === 'blob:none')) {
      let i = 0;
      const d = obj.data;
      while (i < d.length) {
        const nul = d.indexOf(0, i);
        const mode = new TextDecoder().decode(d.subarray(i, d.indexOf(0x20, i)));
        const child = Buffer.from(d.subarray(nul + 1, nul + 21)).toString('hex');
        if (mode !== '160000') out.push(...this.closure(child, filter, false));
        i = nul + 21;
      }
    }
    return out;
  }

  policyFetch(host: string): PolicyFetch {
    const inner = createPolicyFetch({
      policy,
      userAgent: 'package-broker-test',
      fetchImpl: async (input, init) => {
        if (this.override) {
          this.requests.push(parseRequest(init?.body as Uint8Array));
          return this.override();
        }
        expect(String(input)).toBe(`https://${host}/acme/lib.git/git-upload-pack`);
        expect(init?.method).toBe('POST');
        const wire = parseRequest(init?.body as Uint8Array);
        this.requests.push(wire);
        if (wire.filter !== undefined && this.rejected.has(wire.filter)) {
          const status = this.httpStatus.get(wire.filter);
          if (status !== undefined) return new Response('no', { status });
          return new Response(errResponse(this.errorText), { headers: { 'content-type': RESULT } });
        }
        const picked = new Map<string, Obj>();
        for (const want of wire.wants) {
          for (const o of this.closure(want, wire.filter, true)) picked.set(o.oid, o);
        }
        return new Response(fetchResponse(buildPack([...picked.values()])), {
          headers: { 'content-type': RESULT },
        });
      },
    });
    return (request) => {
      this.seen.push(request);
      return inner(request);
    };
  }
}

const url = (host: string) => `https://${host}/acme/lib.git`;
const ctx = (
  fake: FakeGit,
  host: string,
  runtime: 'docker' | 'cloudflare' = 'docker',
  extra: Partial<GitFetchContext> = {},
): GitFetchContext => ({
  policyFetch: fake.policyFetch(host),
  codecs,
  runtime,
  ...extra,
});

interface Release {
  ref: { name: string; oid: string };
  commit: Obj;
  blob: Obj;
}

function seedReleases(fake: FakeGit, count: number, shared = 0): Release[] {
  const out: Release[] = [];
  for (let n = 0; n < count; n++) {
    const body =
      n < shared ? '{"name":"acme/lib","version":"shared"}' : `{"name":"acme/lib","n":${n}}`;
    const blob = fake.add(makeObj('blob', enc.encode(body)));
    const readme = fake.add(makeObj('blob', enc.encode(`readme ${n}`)));
    const tree = fake.add(
      makeTree([
        { mode: '100644', name: 'README.md', oid: readme.oid },
        { mode: '100644', name: 'composer.json', oid: blob.oid },
      ]),
    );
    const commit = fake.add(makeCommit(tree.oid, 1_700_000_000 + n * 86_400));
    out.push({ ref: { name: `refs/tags/v1.${n}.0`, oid: commit.oid }, commit, blob });
  }
  return out;
}

function manifests(fake: FakeGit, count: number) {
  return Array.from({ length: count }, (_, n) => {
    const blob = fake.add(manifestBlob(n));
    const tree = fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }]));
    return { name: `refs/tags/v${n}`, oid: fake.add(makeCommit(tree.oid)).oid };
  });
}

const wideFixture = once(() => {
  const blob = makeObj('blob', enc.encode('{}'));
  const tree = makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }]);
  const commits = Array.from({ length: MAX_WANTS_PER_REQUEST + 1 }, (_, n) =>
    makeCommit(tree.oid, 1_000_000 + n),
  );
  return { objects: [blob, tree, ...commits], commits };
});

function wideRefs(fake: FakeGit) {
  const { objects, commits } = wideFixture();
  for (const o of objects) fake.add(o);
  return commits.map((c, n) => ({ name: `refs/tags/v${n}`, oid: c.oid }));
}

describe('readFileAtRefs', () => {
  it('reads composer.json at 41 refs in three requests once the host filter is known', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    const host = 'three.example.com';
    const releases = seedReleases(fake, 41);
    await readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json');
    fake.requests.length = 0;

    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      releases.map((r) => r.ref),
      'composer.json',
    );

    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map((r) => r.filter)).toEqual(['tree:0', 'tree:0', undefined]);
    expect(fake.requests[0]?.deepen).toBe('1');
    expect(fake.requests[0]?.lines).toContain('no-progress');
    expect(fake.requests[0]?.lines).toContain('ofs-delta');
    expect(result).toHaveLength(41);
    expect(result[7]).toEqual({
      ref: 'refs/tags/v1.7.0',
      commit: releases[7]!.commit.oid,
      committedAt: new Date((1_700_000_000 + 7 * 86_400) * 1000).toISOString(),
      text: '{"name":"acme/lib","n":7}',
    });
    expect(result.every((r) => r.text !== null)).toBe(true);
  });

  it('needs two requests when the host accepts tree:1', async () => {
    const fake = new FakeGit();
    const host = 'accepts.example.com';
    const releases = seedReleases(fake, 5);
    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      releases.map((r) => r.ref),
      'composer.json',
    );
    expect(fake.requests.map((r) => r.filter)).toEqual(['tree:1', undefined]);
    expect(result.map((r) => r.text)).toEqual(
      releases.map((r) => new TextDecoder().decode(r.blob.data)),
    );
  });

  it('falls back from tree:1 to tree:0 once, then starts at tree:0 for that host', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    const host = 'github-like.example.com';
    const releases = seedReleases(fake, 2);
    const refs = releases.map((r) => r.ref);

    await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(fake.requests.map((r) => r.filter)).toEqual(['tree:1', 'tree:0', 'tree:0', undefined]);

    fake.requests.length = 0;
    await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(fake.requests.map((r) => r.filter)).toEqual(['tree:0', 'tree:0', undefined]);

    fake.requests.length = 0;
    const other = 'other-host.example.com';
    await readFileAtRefs(ctx(fake, other), url(other), refs, 'composer.json');
    expect(fake.requests[0]?.filter).toBe('tree:1');
  });

  it('falls back to blob:none after tree:1 and tree:0', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1').add('tree:0');
    const host = 'blobnone.example.com';
    const releases = seedReleases(fake, 2);
    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      releases.map((r) => r.ref),
      'composer.json',
    );
    expect(fake.requests.map((r) => r.filter).slice(0, 3)).toEqual([
      'tree:1',
      'tree:0',
      'blob:none',
    ]);
    expect(result.every((r) => r.text !== null)).toBe(true);
  });

  it('ends with a full fetch when every filter is rejected', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1').add('tree:0').add('blob:none');
    const host = 'nofilter.example.com';
    const releases = seedReleases(fake, 2);
    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      releases.map((r) => r.ref),
      'composer.json',
    );
    expect(fake.requests.map((r) => r.filter)).toEqual([
      'tree:1',
      'tree:0',
      'blob:none',
      undefined,
    ]);
    expect(result.every((r) => r.text !== null)).toBe(true);
  });

  it('rethrows the remote error when the full fetch is refused too', async () => {
    const fake = new FakeGit();
    fake.override = () => new Response(errResponse(), { headers: { 'content-type': RESULT } });
    const host = 'refused.example.com';
    const releases = seedReleases(fake, 1);
    await expect(
      readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(fake.requests).toHaveLength(4);
  });

  it('skips the filters when the caller discovered no filter capability', async () => {
    const fake = new FakeGit();
    const host = 'nocap.example.com';
    const releases = seedReleases(fake, 3);
    const cache = createFilterStrategyCache();
    const result = await readFileAtRefs(
      ctx(fake, host, 'docker', { capabilities: { filter: false }, filterCache: cache }),
      url(host),
      releases.map((r) => r.ref),
      'composer.json',
    );
    expect(fake.requests.map((r) => r.filter)).toEqual([undefined]);
    expect(fake.requests[0]?.lines.some((l) => l.startsWith('filter'))).toBe(false);
    expect(cache.get(host)).toBeUndefined();
    expect(result.every((r) => r.text !== null)).toBe(true);
  });

  it('keeps the remembered strategy in the injected cache only', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    const host = 'injected.example.com';
    const releases = seedReleases(fake, 1);
    const refs = [releases[0]!.ref];
    const cache = createFilterStrategyCache();
    await readFileAtRefs(
      ctx(fake, host, 'docker', { filterCache: cache }),
      url(host),
      refs,
      'composer.json',
    );
    expect(cache.get(host)).toBe(1);
    fake.requests.length = 0;
    await readFileAtRefs(
      ctx(fake, host, 'docker', { filterCache: createFilterStrategyCache() }),
      url(host),
      refs,
      'composer.json',
    );
    expect(fake.requests[0]?.filter).toBe('tree:1');
  });

  it('does not fall back on an HTTP 400', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    fake.httpStatus.set('tree:1', 400);
    const host = 'http400.example.com';
    const releases = seedReleases(fake, 1);
    await expect(
      readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(fake.requests).toHaveLength(1);
  });

  it('does not treat a not-our-ref ERR as a filter rejection', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    fake.errorText = 'upload-pack: not our ref ' + 'a'.repeat(40);
    const host = 'notourref.example.com';
    const releases = seedReleases(fake, 1);
    await expect(
      readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(fake.requests).toHaveLength(1);
  });

  it('does not fall back on a band 3 error or an ERR after the first section', async () => {
    const host = 'band3.example.com';
    const band3 = new FakeGit();
    const releases = seedReleases(band3, 1);
    band3.override = () =>
      new Response(
        concat([
          encodePkt('packfile\n'),
          encodePkt(concat([Uint8Array.of(3), enc.encode('fatal: boom')])),
          FLUSH,
        ]),
        { headers: { 'content-type': RESULT } },
      );
    await expect(
      readFileAtRefs(ctx(band3, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(band3.requests).toHaveLength(1);

    const late = new FakeGit();
    seedReleases(late, 1);
    late.override = () =>
      new Response(concat([encodePkt('packfile\n'), errResponse()]), {
        headers: { 'content-type': RESULT },
      });
    await expect(
      readFileAtRefs(
        ctx(late, 'late.example.com'),
        url('late.example.com'),
        [releases[0]!.ref],
        'composer.json',
      ),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(late.requests).toHaveLength(1);
  });

  it('does not fall back on a 5xx status', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    fake.httpStatus.set('tree:1', 503);
    const host = 'flaky.example.com';
    const releases = seedReleases(fake, 1);
    await expect(
      readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(fake.requests).toHaveLength(1);
  });

  it('asks for each commit and blob once and uses the peeled commit of annotated tags', async () => {
    const fake = new FakeGit();
    const host = 'dedupe.example.com';
    const releases = seedReleases(fake, 4, 4);
    const refs = [
      { name: 'refs/tags/v1.0.0', oid: 'f'.repeat(40), peeled: releases[0]!.commit.oid },
      { name: 'refs/heads/main', oid: releases[0]!.commit.oid },
      releases[1]!.ref,
      releases[2]!.ref,
    ];
    const result = await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(result.map((r) => r.commit)).toEqual([
      releases[0]!.commit.oid,
      releases[0]!.commit.oid,
      releases[1]!.commit.oid,
      releases[2]!.commit.oid,
    ]);
    expect(fake.requests[0]?.wants).toHaveLength(3);
    const blobWants = fake.requests.at(-1)?.wants ?? [];
    expect(blobWants).toHaveLength(new Set(blobWants).size);
    expect(blobWants).toHaveLength(1);
  });

  it('reports per-ref reasons without failing the batch', async () => {
    const fake = new FakeGit();
    const host = 'reasons.example.com';
    const huge = fake.add(makeObj('blob', new Uint8Array(1024 * 1024 + 1).fill(0x61)));
    const link = fake.add(makeObj('blob', enc.encode('../elsewhere')));
    const bad = fake.add(makeObj('blob', Uint8Array.of(0xff, 0xfe, 0x7b)));
    const ok = fake.add(makeObj('blob', enc.encode('{}')));
    const emptyTree = fake.add(makeTree([]));
    const dirTree = fake.add(
      makeTree([{ mode: '40000', name: 'composer.json', oid: emptyTree.oid }]),
    );
    const mk = (item: TreeItem | null, name: string) => {
      const tree = fake.add(makeTree(item ? [item] : []));
      return { name, oid: fake.add(makeCommit(tree.oid)).oid };
    };
    const dirCommit = fake.add(makeCommit(dirTree.oid));
    const refs = [
      mk({ mode: '100644', name: 'composer.json', oid: ok.oid }, 'refs/tags/ok'),
      mk(null, 'refs/tags/missing'),
      mk({ mode: '120000', name: 'composer.json', oid: link.oid }, 'refs/tags/link'),
      mk({ mode: '100644', name: 'composer.json', oid: huge.oid }, 'refs/tags/huge'),
      mk({ mode: '100644', name: 'composer.json', oid: bad.oid }, 'refs/tags/bad'),
      { name: 'refs/tags/dir', oid: dirCommit.oid },
    ];
    const result = await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(result.map((r) => [r.ref, r.text, r.reason])).toEqual([
      ['refs/tags/ok', '{}', undefined],
      ['refs/tags/missing', null, 'missing'],
      ['refs/tags/link', null, 'not_a_file'],
      ['refs/tags/huge', null, 'too_large'],
      ['refs/tags/bad', null, 'not_utf8'],
      ['refs/tags/dir', null, 'not_a_file'],
    ]);
  });

  it('keeps a BOM-prefixed name distinct from the plain name', async () => {
    const fake = new FakeGit();
    const host = 'bom.example.com';
    const plain = fake.add(makeObj('blob', enc.encode('{"plain":1}')));
    const bom = fake.add(makeObj('blob', enc.encode('{"bom":1}')));
    const tree = fake.add(
      makeTree([
        { mode: '100644', name: '\ufeffcomposer.json', oid: bom.oid },
        { mode: '100644', name: 'composer.json', oid: plain.oid },
      ]),
    );
    const commit = fake.add(makeCommit(tree.oid));
    const [first] = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [{ name: 'refs/tags/t', oid: commit.oid }],
      'composer.json',
    );
    expect(first?.text).toBe('{"plain":1}');
  });

  it('formats the committer time as UTC regardless of the zone', async () => {
    const fake = new FakeGit();
    const host = 'zone.example.com';
    const blob = fake.add(makeObj('blob', enc.encode('{}')));
    const tree = fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }]));
    const commit = fake.add(makeCommit(tree.oid, 1_700_000_000, '-0930'));
    const [first] = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [{ name: 'refs/tags/z', oid: commit.oid }],
      'composer.json',
    );
    expect(first?.committedAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('fails only the ref whose commit has no tree line or committer', async () => {
    const fake = new FakeGit();
    const host = 'badcommit.example.com';
    const good = seedReleases(fake, 1)[0]!;
    const noTree = fake.add(makeObj('commit', enc.encode('author x <y> 1 +0000\n\nmsg\n')));
    const tree = fake.add(makeTree([]));
    const noCommitter = fake.add(
      makeObj('commit', enc.encode(`tree ${tree.oid}\nauthor x <y> 1 +0000\n\nmsg\n`)),
    );
    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [
        { name: 'refs/tags/a', oid: noTree.oid },
        good.ref,
        { name: 'refs/tags/b', oid: noCommitter.oid },
      ],
      'composer.json',
    );
    expect(result.map((r) => [r.ref, r.reason ?? 'ok'])).toEqual([
      ['refs/tags/a', 'bad_commit'],
      [good.ref.name, 'ok'],
      ['refs/tags/b', 'bad_commit'],
    ]);
  });

  it('accepts a commit whose committer line has no timezone', async () => {
    const fake = new FakeGit();
    const host = 'notz.example.com';
    const blob = fake.add(makeObj('blob', enc.encode('{}')));
    const tree = fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }]));
    const commit = fake.add(
      makeObj(
        'commit',
        enc.encode(`tree ${tree.oid}\nauthor a <b> 1700000000\ncommitter a <b> 1700000000\n\nm\n`),
      ),
    );
    const [first] = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [{ name: 'refs/tags/t', oid: commit.oid }],
      'composer.json',
    );
    expect(first).toMatchObject({ committedAt: '2023-11-14T22:13:20.000Z', text: '{}' });
  });

  it('fails only the ref that peels to a tree or blob', async () => {
    const fake = new FakeGit();
    const host = 'notcommit.example.com';
    const good = seedReleases(fake, 1)[0]!;
    const tree = fake.add(makeTree([]));
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [
        { name: 'refs/tags/tree', oid: 'f'.repeat(40), peeled: tree.oid },
        { name: 'refs/tags/blob', oid: blob.oid },
        good.ref,
      ],
      'composer.json',
    );
    expect(result.map((r) => [r.ref, r.text === null ? r.reason : 'ok'])).toEqual([
      ['refs/tags/tree', 'not_a_commit'],
      ['refs/tags/blob', 'not_a_commit'],
      [good.ref.name, 'ok'],
    ]);
  });

  it('fails only the ref with a malformed or legacy root tree', async () => {
    const fake = new FakeGit();
    const host = 'badtree.example.com';
    const blob = fake.add(makeObj('blob', enc.encode('{"ok":1}')));
    const commitOf = (data: Uint8Array) =>
      fake.add(makeCommit(fake.add(makeObj('tree', data)).oid)).oid;
    const oidBytes = Uint8Array.from(Buffer.from(blob.oid, 'hex'));
    const entry = (mode: string, name: Uint8Array | string) =>
      concat([
        enc.encode(`${mode} `),
        typeof name === 'string' ? enc.encode(name) : name,
        Uint8Array.of(0),
        oidBytes,
      ]);
    const refs = [
      { name: 'refs/tags/truncated', oid: commitOf(enc.encode('100644 composer.json\0abc')) },
      { name: 'refs/tags/legacy', oid: commitOf(entry('100664', 'composer.json')) },
      { name: 'refs/tags/badmode', oid: commitOf(entry('100600', 'composer.json')) },
      {
        name: 'refs/tags/tolerant',
        oid: commitOf(
          concat([
            entry('0100644', 'README'),
            entry('999999', 'weird'),
            entry('100644', Uint8Array.of(0xff, 0xfe)),
            entry('100644', '.git'),
            entry('100644', 'composer.json'),
          ]),
        ),
      },
    ];
    const result = await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(result.map((r) => [r.ref, r.text, r.reason])).toEqual([
      ['refs/tags/truncated', null, 'bad_tree'],
      ['refs/tags/legacy', '{"ok":1}', undefined],
      ['refs/tags/badmode', null, 'bad_tree'],
      ['refs/tags/tolerant', '{"ok":1}', undefined],
    ]);
  });

  it('fails when the server omits a requested object', async () => {
    const fake = new FakeGit();
    const host = 'omits.example.com';
    const releases = seedReleases(fake, 1);
    fake.dropFromPacks.add(releases[0]!.commit.oid);
    await expect(
      readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toMatchObject({ code: 'missing_object' });
  });

  it('rejects paths that are not a single file name and refs that are not commit ids', async () => {
    const fake = new FakeGit();
    const host = 'paths.example.com';
    const releases = seedReleases(fake, 1);
    for (const path of ['', '.', '..', 'a/b', 'a\0b']) {
      await expect(
        readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], path),
      ).rejects.toMatchObject({ code: 'bad_path' });
    }
    await expect(
      readFileAtRefs(
        ctx(fake, host),
        url(host),
        [{ name: 'refs/tags/x', oid: 'xyz' }],
        'composer.json',
      ),
    ).rejects.toMatchObject({ code: 'bad_ref' });
    expect(fake.requests).toHaveLength(0);
  });

  it('returns an empty list without a request for no refs', async () => {
    const fake = new FakeGit();
    expect(
      await readFileAtRefs(
        ctx(fake, 'none.example.com'),
        url('none.example.com'),
        [],
        'composer.json',
      ),
    ).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it('caps the pack response at 16 MiB on Workers and 64 MiB on Docker', async () => {
    const fake = new FakeGit();
    const releases = seedReleases(fake, 1);
    await readFileAtRefs(
      ctx(fake, 'cap-w.example.com', 'cloudflare'),
      url('cap-w.example.com'),
      [releases[0]!.ref],
      'composer.json',
    );
    await readFileAtRefs(
      ctx(fake, 'cap-d.example.com', 'docker'),
      url('cap-d.example.com'),
      [releases[0]!.ref],
      'composer.json',
    );
    const sizes = fake.seen.map((r) => r.maxBytes);
    expect(new Set(sizes.slice(0, sizes.length / 2))).toEqual(new Set([16 * 1024 * 1024]));
    expect(new Set(sizes.slice(sizes.length / 2))).toEqual(new Set([64 * 1024 * 1024]));
    expect(fake.seen.every((r) => r.purpose === 'git' && r.method === 'POST')).toBe(true);
  });

  it('fails the call with too_large when the retained budget is exhausted', async () => {
    const fake = new FakeGit();
    const host = 'budget.example.com';
    const refs = manifests(fake, 30);
    await expect(
      readFileAtRefs(ctx(fake, host, 'cloudflare'), url(host), refs, 'composer.json'),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('never reports a manifest under 1 MiB as too_large when it fits the budget', async () => {
    const fake = new FakeGit();
    const host = 'fits.example.com';
    const result = await readFileAtRefs(
      ctx(fake, host, 'cloudflare'),
      url(host),
      manifests(fake, 20),
      'composer.json',
    );
    expect(result.every((r) => r.text !== null && r.reason === undefined)).toBe(true);
  });

  it('isolates oversize blobs by bisection within the request cap', async () => {
    const fake = new FakeGit();
    const host = 'bisect.example.com';
    const big = fake.add(bigBlob());
    const small = Array.from({ length: 8 }, (_, n) =>
      fake.add(makeObj('blob', enc.encode(`{"n":${n}}`))),
    );
    const mk = (name: string, blob: Obj) => ({
      name,
      oid: fake.add(
        makeCommit(
          fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }])).oid,
        ),
      ).oid,
    });
    const refs = [mk('refs/tags/big', big), ...small.map((b, n) => mk(`refs/tags/s${n}`, b))];
    const result = await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(result[0]).toMatchObject({ text: null, reason: 'too_large' });
    expect(result.slice(1).every((r) => r.text !== null)).toBe(true);
    const blobRequests = fake.requests.filter((r) => r.filter === undefined);
    expect(blobRequests.length).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(10)) + 2);
  });

  it('marks three oversize blobs among 41 refs without failing the call', async () => {
    const fake = new FakeGit();
    const host = 'threebig.example.com';
    const bigs = [3, 17, 33].map((n) => n);
    const refs = Array.from({ length: 41 }, (_, n) => {
      const blob = fake.add(
        bigs.includes(n) ? bigBlobFilled(65 + n) : makeObj('blob', enc.encode(`{"n":${n}}`)),
      );
      const tree = fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }]));
      return { name: `refs/tags/v${n}`, oid: fake.add(makeCommit(tree.oid, 1_000 + n)).oid };
    });
    const result = await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
    expect(result.flatMap((r, n) => (r.reason === 'too_large' ? [n] : []))).toEqual(bigs);
    expect(result.filter((r) => r.text !== null)).toHaveLength(38);
  });

  it('treats a pack over the response cap like an oversize blob', async () => {
    const fake = new FakeGit();
    const host = 'packcap.example.com';
    const big = fake.add(incompressibleBlob());
    const small = fake.add(makeObj('blob', enc.encode('{}')));
    const mk = (name: string, blob: Obj) => ({
      name,
      oid: fake.add(
        makeCommit(
          fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }])).oid,
        ),
      ).oid,
    });
    const result = await readFileAtRefs(
      ctx(fake, host, 'cloudflare'),
      url(host),
      [mk('refs/tags/big', big), mk('refs/tags/small', small)],
      'composer.json',
    );
    expect(result.map((r) => [r.ref, r.text, r.reason])).toEqual([
      ['refs/tags/big', null, 'too_large'],
      ['refs/tags/small', '{}', undefined],
    ]);
  });

  // Inflating 10,001 distinct commits is the boundary under test and cannot shrink; the budget absorbs a loaded CI host.
  it(
    'refetches only the failing chunk when a filter is rejected mid-way',
    { timeout: 20_000 },
    async () => {
      const fake = new FakeGit();
      fake.rejected.add('tree:1');
      const host = 'chunkfallback.example.com';
      const refs = wideRefs(fake);
      await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
      expect(fake.requests.slice(0, 3).map((r) => [r.filter, r.wants.length])).toEqual([
        ['tree:1', MAX_WANTS_PER_REQUEST],
        ['tree:0', MAX_WANTS_PER_REQUEST],
        ['tree:0', 1],
      ]);
    },
  );

  it('treats an ERR that does not mention the filter as a plain remote error', async () => {
    const fake = new FakeGit();
    fake.rejected.add('tree:1');
    fake.errorText = 'access denied';
    const host = 'denied.example.com';
    const releases = seedReleases(fake, 1);
    await expect(
      readFileAtRefs(ctx(fake, host), url(host), [releases[0]!.ref], 'composer.json'),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(fake.requests).toHaveLength(1);
  });

  it('marks a single blob over the object cap too_large and keeps the others', async () => {
    const fake = new FakeGit();
    const host = 'bigblob.example.com';
    const big = fake.add(bigBlob());
    const small = fake.add(makeObj('blob', enc.encode('{}')));
    const mk = (name: string, blob: Obj) => ({
      name,
      oid: fake.add(
        makeCommit(
          fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }])).oid,
        ),
      ).oid,
    });
    const result = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [mk('refs/tags/big', big), mk('refs/tags/small', small)],
      'composer.json',
    );
    expect(result.map((r) => [r.ref, r.text, r.reason])).toEqual([
      ['refs/tags/big', null, 'too_large'],
      ['refs/tags/small', '{}', undefined],
    ]);
  });

  it('maps a budget overflow while fetching commits to too_large', async () => {
    const fake = new FakeGit();
    const host = 'commitbudget.example.com';
    const refs = Array.from({ length: 30 }, (_, n) => {
      const blob = fake.add(manifestBlob(n));
      const tree = fake.add(makeTree([{ mode: '100644', name: 'composer.json', oid: blob.oid }]));
      return { name: `refs/tags/v${n}`, oid: fake.add(makeCommit(tree.oid)).oid };
    });
    await expect(
      readFileAtRefs(
        ctx(fake, host, 'cloudflare', { capabilities: { filter: false } }),
        url(host),
        refs,
        'composer.json',
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('maps a corrupt pack to bad_response', async () => {
    const fake = new FakeGit();
    const releases = seedReleases(fake, 1);
    const pack = buildPack([releases[0]!.commit]);
    pack.set([(pack.at(-1) ?? 0) ^ 0xff], pack.length - 1);
    fake.override = () =>
      new Response(fetchResponse(pack), { headers: { 'content-type': RESULT } });
    await expect(
      readFileAtRefs(
        ctx(fake, 'corrupt.example.com'),
        url('corrupt.example.com'),
        [releases[0]!.ref],
        'composer.json',
      ),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  // Inflating 10,001 distinct commits is the boundary under test and cannot shrink; the budget absorbs a loaded CI host.
  it(
    'splits more than 10,000 wants over several requests under the body cap',
    { timeout: 20_000 },
    async () => {
      const fake = new FakeGit();
      const host = 'many.example.com';
      const refs = wideRefs(fake);
      const result = await readFileAtRefs(ctx(fake, host), url(host), refs, 'composer.json');
      expect(result).toHaveLength(MAX_WANTS_PER_REQUEST + 1);
      expect(result.every((r) => r.text === '{}')).toBe(true);
      expect(fake.requests.slice(0, 2).map((r) => r.wants.length)).toEqual([
        MAX_WANTS_PER_REQUEST,
        1,
      ]);
      expect(fake.seen.every((r) => (r.body?.length ?? 0) < 1024 * 1024)).toBe(true);
    },
  );

  it('never puts the committer e-mail in an error', async () => {
    const fake = new FakeGit();
    const host = 'leak.example.com';
    const noCommitter = fake.add(
      makeObj('commit', enc.encode(`tree ${'a'.repeat(40)}\nauthor dev@example.com\n\nmsg\n`)),
    );
    const error = await readFileAtRefs(
      ctx(fake, host),
      url(host),
      [{ name: 'refs/tags/x', oid: noCommitter.oid }],
      'composer.json',
    ).catch((e: unknown) => e);
    expect(error).toEqual([
      {
        ref: 'refs/tags/x',
        commit: noCommitter.oid,
        committedAt: null,
        text: null,
        reason: 'bad_commit',
      },
    ]);
    expect(error).not.toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain('dev@');
  });
});

function fullRepo(fake: FakeGit) {
  const lib = fake.add(makeObj('blob', enc.encode('lib')));
  const exe = fake.add(makeObj('blob', enc.encode('exe')));
  const link = fake.add(makeObj('blob', enc.encode('lib')));
  const src = fake.add(
    makeTree([
      { mode: '100755', name: 'run.sh', oid: exe.oid },
      { mode: '100644', name: 'lib.php', oid: lib.oid },
    ]),
  );
  const submodule = 'e'.repeat(40);
  const root = fake.add(
    makeTree([
      { mode: '120000', name: 'link', oid: link.oid },
      { mode: '160000', name: 'mod', oid: submodule },
      { mode: '40000', name: 'src', oid: src.oid },
    ]),
  );
  return { commit: fake.add(makeCommit(root.oid)), lib, exe, link, submodule };
}

describe('readTreeAtCommit', () => {
  it('lists every entry with its path, mode and object id', async () => {
    const fake = new FakeGit();
    const host = 'tree.example.com';
    const repo = fullRepo(fake);
    const tree = await readTreeAtCommit(ctx(fake, host), url(host), repo.commit.oid);
    expect(tree.committedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(tree.entries.map((e) => [e.path, e.mode, e.type, e.oid])).toEqual([
      ['link', '120000', 'blob', repo.link.oid],
      ['mod', '160000', 'commit', repo.submodule],
      ['src', '40000', 'tree', expect.any(String)],
      ['src/run.sh', '100755', 'blob', repo.exe.oid],
      ['src/lib.php', '100644', 'blob', repo.lib.oid],
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.filter).toBe('blob:none');
    expect(fake.requests[0]?.deepen).toBe('1');
  });

  it('throws git_archive_requires_docker on Workers without a request', async () => {
    const fake = new FakeGit();
    const host = 'tree-w.example.com';
    const repo = fullRepo(fake);
    await expect(
      readTreeAtCommit(ctx(fake, host, 'cloudflare'), url(host), repo.commit.oid),
    ).rejects.toMatchObject({ code: 'git_archive_requires_docker' });
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a tree above 20,000 entries', async () => {
    const fake = new FakeGit();
    const host = 'wide.example.com';
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const mk = (count: number, tag: string) => {
      const root = fake.add(
        makeTree(
          Array.from({ length: count }, (_, n) => ({
            mode: '100644',
            name: `f${String(n).padStart(6, '0')}`,
            oid: blob.oid,
          })),
        ),
      );
      return fake.add(makeCommit(root.oid, tag === 'a' ? 1 : 2));
    };
    const at = mk(20_000, 'a');
    expect((await readTreeAtCommit(ctx(fake, host), url(host), at.oid)).entries).toHaveLength(
      20_000,
    );
    const over = mk(20_001, 'b');
    await expect(readTreeAtCommit(ctx(fake, host), url(host), over.oid)).rejects.toMatchObject({
      code: 'tree_too_large',
    });
  });

  it('counts entries across subtrees', async () => {
    const fake = new FakeGit();
    const host = 'deep.example.com';
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const dirs = Array.from(
      { length: 3 },
      () =>
        fake.add(
          makeTree(
            Array.from({ length: 7000 }, (_, n) => ({
              mode: '100644',
              name: `f${n}`,
              oid: blob.oid,
            })),
          ),
        ).oid,
    );
    const root = fake.add(makeTree(dirs.map((oid, d) => ({ mode: '40000', name: `d${d}`, oid }))));
    const commit = fake.add(makeCommit(root.oid));
    await expect(readTreeAtCommit(ctx(fake, host), url(host), commit.oid)).rejects.toMatchObject({
      code: 'tree_too_large',
    });
  });

  it('rejects invalid modes, names and truncated tree entries', async () => {
    const fake = new FakeGit();
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const cases: [string, TreeItem[]][] = [
      ['mode-a', [{ mode: '100664', name: 'a', oid: blob.oid }]],
      ['mode-b', [{ mode: '0100644', name: 'a', oid: blob.oid }]],
      ['mode-c', [{ mode: '10064x', name: 'a', oid: blob.oid }]],
      ['name-a', [{ mode: '100644', name: '..', oid: blob.oid }]],
      ['name-b', [{ mode: '100644', name: 'a/b', oid: blob.oid }]],
      ['name-c', [{ mode: '100644', name: '.git', oid: blob.oid }]],
      [
        'dup',
        [
          { mode: '100644', name: 'a', oid: blob.oid },
          { mode: '100644', name: 'a', oid: blob.oid },
        ],
      ],
    ];
    for (const [label, items] of cases) {
      const host = `${label}.example.com`;
      const commit = fake.add(makeCommit(fake.add(makeTree(items)).oid));
      await expect(
        readTreeAtCommit(ctx(fake, host), url(host), commit.oid),
        label,
      ).rejects.toMatchObject({
        code: 'bad_object',
      });
    }
    const truncated = fake.add(makeObj('tree', enc.encode('100644 a\0abc')));
    const commit = fake.add(makeCommit(truncated.oid));
    await expect(
      readTreeAtCommit(ctx(fake, 'trunc.example.com'), url('trunc.example.com'), commit.oid),
    ).rejects.toMatchObject({ code: 'bad_object' });
  });

  it('fails when a subtree is missing from the pack', async () => {
    const fake = new FakeGit();
    const host = 'missing-sub.example.com';
    const repo = fullRepo(fake);
    const src = [...fake.objects.values()].find(
      (o) => o.type === 'tree' && new TextDecoder().decode(o.data).includes('lib.php'),
    )!;
    fake.dropFromPacks.add(src.oid);
    await expect(
      readTreeAtCommit(ctx(fake, host), url(host), repo.commit.oid),
    ).rejects.toMatchObject({ code: 'missing_object' });
  });

  it('refuses a malformed commit id', async () => {
    const fake = new FakeGit();
    await expect(
      readTreeAtCommit(ctx(fake, 'x.example.com'), url('x.example.com'), 'main'),
    ).rejects.toMatchObject({ code: 'bad_ref' });
  });
  it('rejects unsafe tree names', async () => {
    const fake = new FakeGit();
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const names = [
      'git~1',
      'GIT~1',
      '.git ',
      '.git.',
      '.g\u200cit',
      'a\\b',
      'a\u0001b',
      '.GiT',
      '.git::$INDEX_ALLOCATION',
      'gi7eba~1',
      'GI7EBA~9',
    ];
    for (const [n, name] of names.entries()) {
      const host = `unsafe${n}.example.com`;
      const commit = fake.add(
        makeCommit(fake.add(makeTree([{ mode: '100644', name, oid: blob.oid }])).oid, 100 + n),
      );
      await expect(
        readTreeAtCommit(ctx(fake, host), url(host), commit.oid),
        name,
      ).rejects.toMatchObject({
        code: 'bad_object',
      });
    }
  });

  it('skips tree entries whose name is not valid UTF-8', async () => {
    const fake = new FakeGit();
    const host = 'latin1.example.com';
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const oidBytes = Uint8Array.from(Buffer.from(blob.oid, 'hex'));
    const entry = (name: Uint8Array) =>
      concat([enc.encode('100644 '), name, Uint8Array.of(0), oidBytes]);
    const tree = fake.add(
      makeObj('tree', concat([entry(Uint8Array.of(0xff, 0xfe)), entry(enc.encode('ok'))])),
    );
    const commit = fake.add(makeCommit(tree.oid));
    const result = await readTreeAtCommit(ctx(fake, host), url(host), commit.oid);
    expect(result.entries.map((e) => e.path)).toEqual(['ok']);
    expect(result.skipped).toBe(1);
  });

  it('counts skipped entries toward the 20,000 entry limit', async () => {
    const fake = new FakeGit();
    const blob = fake.add(makeObj('blob', enc.encode('x')));
    const oidBytes = Uint8Array.from(Buffer.from(blob.oid, 'hex'));
    const bad = (n: number) =>
      concat([enc.encode('100644 '), Uint8Array.of(0xff), enc.encode(`${n}\0`), oidBytes]);
    const good = (n: number) =>
      concat([enc.encode(`100644 f${String(n).padStart(6, '0')}\0`), oidBytes]);
    const build = (valid: number, invalid: number, stamp: number) =>
      fake.add(
        makeCommit(
          fake.add(
            makeObj(
              'tree',
              concat([
                ...Array.from({ length: valid }, (_, n) => good(n)),
                ...Array.from({ length: invalid }, (_, n) => bad(n)),
              ]),
            ),
          ).oid,
          stamp,
        ),
      );
    const host = 'skipcount.example.com';
    const at = await readTreeAtCommit(ctx(fake, host), url(host), build(19_998, 2, 1).oid);
    expect(at.entries).toHaveLength(19_998);
    expect(at.skipped).toBe(2);
    await expect(
      readTreeAtCommit(ctx(fake, host), url(host), build(19_999, 2, 2).oid),
    ).rejects.toMatchObject({ code: 'tree_too_large' });
  });

  it('falls back to a full fetch when blob:none is rejected or no filter is advertised', async () => {
    const fake = new FakeGit();
    fake.rejected.add('blob:none');
    const repo = fullRepo(fake);
    const host = 'treefallback.example.com';
    const viaReject = await readTreeAtCommit(ctx(fake, host), url(host), repo.commit.oid);
    expect(fake.requests.map((r) => r.filter)).toEqual(['blob:none', undefined]);

    fake.requests.length = 0;
    const viaCaps = await readTreeAtCommit(
      ctx(fake, host, 'docker', { capabilities: { filter: false } }),
      url(host),
      repo.commit.oid,
    );
    expect(fake.requests.map((r) => r.filter)).toEqual([undefined]);
    expect(viaCaps.entries).toEqual(viaReject.entries);
    expect(viaCaps.entries).toHaveLength(5);
  });
});

describe('fail-closed protocol handling', () => {
  const GOOD = () => {
    const fake = new FakeGit();
    const release = seedReleases(fake, 1)[0]!;
    return { fake, release, body: fetchResponse(buildPack([release.commit])) };
  };
  const ok = { 'content-type': RESULT };
  let n = 0;
  const attempt = async (
    make: (good: Uint8Array) => Response,
    runtime: 'docker' | 'cloudflare' = 'docker',
  ) => {
    const { fake, release, body } = GOOD();
    fake.override = () => make(body);
    const host = `proto${n++}.example.com`;
    return readFileAtRefs(ctx(fake, host, runtime), url(host), [release.ref], 'composer.json').then(
      () => 'resolved',
      (e: unknown) => e,
    );
  };

  it('rejects a wrong content type', async () => {
    expect(
      await attempt((b) => new Response(b, { headers: { 'content-type': 'text/html' } })),
    ).toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects a bad sideband byte', async () => {
    const bad = concat([
      encodePkt('packfile\n'),
      encodePkt(concat([Uint8Array.of(9), enc.encode('x')])),
      FLUSH,
    ]);
    expect(await attempt(() => new Response(bad, { headers: ok }))).toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects a malformed pkt-line header', async () => {
    expect(await attempt(() => new Response(enc.encode('zzzz'), { headers: ok }))).toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects a response above the pack cap', async () => {
    const line = encodePkt(concat([Uint8Array.of(1), new Uint8Array(65_000)]));
    const parts = [encodePkt('packfile\n'), ...Array.from({ length: 270 }, () => line), FLUSH];
    expect(
      await attempt(() => new Response(concat(parts), { headers: ok }), 'cloudflare'),
    ).toMatchObject({ code: 'too_large' });
  });

  it('rejects a stream that ends before the flush', async () => {
    expect(
      await attempt((b) => new Response(b.subarray(0, b.length - 4), { headers: ok })),
    ).toMatchObject({ code: 'bad_response' });
  });

  it('rejects a response without a packfile section', async () => {
    const body = concat([encodePkt('shallow-info\n'), FLUSH]);
    expect(await attempt(() => new Response(body, { headers: ok }))).toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects data after the flush', async () => {
    expect(
      await attempt((b) => new Response(concat([b, encodePkt('extra\n')]), { headers: ok })),
    ).toMatchObject({ code: 'bad_response' });
  });

  it('refuses a redirect status on the POST', async () => {
    expect(await attempt(() => new Response(null, { status: 302 }))).toBeInstanceOf(UpstreamError);
  });

  it('refuses a redirect that carries a Location', async () => {
    const result = await attempt(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.net/x' },
        }),
    );
    expect(result).toBeInstanceOf(UpstreamError);
  });
});
