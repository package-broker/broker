import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import {
  BlobSizeMismatchError,
  BlobValidationError,
  createBlobStore,
  createBlobUploadAdmission,
  type BlobMetadataPort,
  type BlobInfo,
  type ByteStore,
} from '../../platform/blob.js';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { npmVersionInput, type NpmVersionResult } from '../../registry/npm/version-object.js';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamRequest,
} from '../../sources/policy-fetch.js';
import type {
  DescribeOptions,
  PackageDescription,
  SnapshotRef,
  VersionCandidate,
} from '../../sources/provider.js';
import { SnapshotCorruptError, stageSnapshot } from '../snapshot.js';
import { UpstreamUnstableError } from '../two-pass-put.js';
import {
  NPM_INLINE_PARSE_BYTES,
  NpmPackumentError,
  describeNpmPackument,
  versionChunks,
  type NpmDescribeResult,
  type NpmPackumentDeps,
  type NpmPackumentTarget,
  type NpmSnapshotRef,
} from './packument.js';

const ctx = orgContext('01J0ACME000000000000000000');
const enc = new TextEncoder();
const URL_ = 'https://registry.npmjs.org/example';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const origin = {
  probe: { secrets: [], queryParams: [] },
  importedAt: '2026-10-16T00:00:00.000Z',
};

type Json = Record<string, unknown>;

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

function streamOf(bytes: Uint8Array, chunk = 65_536): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else {
        controller.enqueue(bytes.slice(offset, offset + chunk));
        offset += chunk;
      }
    },
  });
}

function memoryStore(chunkSize = 65_536) {
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<string, BlobInfo>();
  const byteStore: ByteStore = {
    async putVerified(key, body, input) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.length !== input.size || sha256(bytes) !== input.sha256) {
        throw new BlobValidationError();
      }
      objects.set(key, bytes);
      return { size: bytes.length, mediaType: input.mediaType };
    },
    async get(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return {
        size: bytes.length,
        mediaType: 'application/json',
        range: null,
        body: streamOf(bytes, chunkSize),
      };
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, mediaType: 'application/json' } : null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  const metadata: BlobMetadataPort = {
    reserve: async () => '1' as never,
    publish: async (c, i) => {
      const info = { sha256: i.sha256, size: i.size, mediaType: i.mediaType, purgeAfter: null };
      rows.set(`${c.orgId}:${i.sha256}`, info);
      return info;
    },
    find: async (c, key) => rows.get(`${c.orgId}:${key}`) ?? null,
    narrowRefetchable: async () => null,
    inspect: async () => null,
  };
  const store = createBlobStore(byteStore, metadata, { admission: createBlobUploadAdmission() });
  return { store, objects };
}

interface Reply {
  status?: number;
  redirected?: boolean;
  body?: Uint8Array | string | null;
  headers?: Record<string, string>;
}

function fakeFetch(reply: (request: UpstreamRequest, call: number) => Reply) {
  const requests: UpstreamRequest[] = [];
  const fetch: PolicyFetch = async (request) => {
    requests.push(request);
    const r = reply(request, requests.length);
    const body =
      r.body === null
        ? null
        : streamOf(typeof r.body === 'string' ? enc.encode(r.body) : (r.body ?? new Uint8Array()));
    return {
      status: r.status ?? 200,
      redirected: r.redirected ?? false,
      headers: new Headers(r.headers ?? {}),
      body,
    };
  };
  return { fetch, requests };
}

function setup(
  reply: (request: UpstreamRequest, call: number) => Reply,
  extra: Pick<NpmPackumentDeps, 'onUpstreamBytes' | 'signal'> = {},
  target: Partial<NpmPackumentTarget> = {},
) {
  const { store, objects } = memoryStore();
  const { fetch, requests } = fakeFetch(reply);
  const deps: NpmPackumentDeps = { ctx, fetch, store, codecs, ...extra };
  const describeWith = (options: DescribeOptions = {}): Promise<NpmDescribeResult> =>
    describeNpmPackument(deps, { name: 'example', url: URL_, ...target }, options);
  return { describeWith, requests, objects };
}

function manifest(key: string, index: number, pad: number, extra: Json = {}): Json {
  return {
    name: 'example',
    version: key,
    description: `release ${index} ${'d'.repeat(pad)}`,
    license: 'MIT',
    dependencies: { left: `^${index % 9}.0.0` },
    dist: {
      tarball: `https://registry.example.test/example/-/example-${key}.tgz`,
      shasum: createHash('sha1').update(key).digest('hex'),
    },
    ...extra,
  };
}

function packument(
  count: number,
  pad: number,
  key: (index: number) => string,
  options: { timeFirst?: boolean; unicode?: boolean } = {},
): Json {
  const versions: Json = {};
  const time: Json = { created: '2020-01-01T00:00:00.000Z', modified: '2024-01-01T00:00:00.000Z' };
  for (let index = 0; index < count; index += 1) {
    const k = key(index);
    versions[k] = manifest(k, index, pad, {
      ...(options.unicode === true ? { readme: `zażółć ${index} \u{1F600}` } : {}),
    });
    if (index % 5 !== 0) time[k] = `2021-0${(index % 9) + 1}-02T03:04:05.${index % 1000}Z`;
  }
  const head = { _id: 'example', name: 'example', 'dist-tags': { latest: key(0), next: key(1) } };
  return options.timeFirst === true
    ? { ...head, time, versions, readme: 'r' }
    : { ...head, versions, time, readme: 'r' };
}

const fixtures: { name: string; text: string; headers: Record<string, string> }[] = [
  {
    name: 'minified, strong ETag',
    text: JSON.stringify(packument(900, 1500, (i) => `1.${i % 17}.${i}`)),
    headers: { etag: '"strong-1"' },
  },
  {
    name: 'pretty, no validators',
    text: JSON.stringify(
      packument(600, 1800, (i) => `2.0.${i}`),
      null,
      2,
    ),
    headers: {},
  },
  {
    name: 'time before versions, weak ETag',
    text: JSON.stringify(
      packument(1000, 1300, (i) => `0.${i}.0-beta.${i % 3}`, { timeFirst: true }),
    ),
    headers: { etag: 'W/"weak"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
  },
  {
    name: 'unicode, lying Content-Length',
    text: JSON.stringify(
      packument(800, 1600, (i) => `3.${i}.1`, { unicode: true }),
      null,
      1,
    ),
    headers: { 'content-length': '100' },
  },
];

const sameLength = (text: string): string => {
  const changed = text.replace('"readme":"r"', '"readme":"s"');
  expect(changed).not.toBe(text);
  return changed;
};

function wholeParse(text: string): NpmVersionResult[] {
  const doc = JSON.parse(text) as { versions: Record<string, Json>; time: Json };
  return Object.entries(doc.versions)
    .filter(([key, value]) => value.version === key)
    .map(([, value]) => npmVersionInput('example', value, doc.time, origin));
}

async function drain(description: PackageDescription): Promise<VersionCandidate[]> {
  const out: VersionCandidate[] = [];
  for await (const member of description.members) out.push(member);
  return out;
}

function inputsOf(members: readonly VersionCandidate[]): NpmVersionResult[] {
  return members.map((m) =>
    npmVersionInput(
      'example',
      JSON.parse(m.raw),
      m.upstreamTime === undefined ? {} : { [m.version]: m.upstreamTime },
      origin,
    ),
  );
}

function described(result: NpmDescribeResult): PackageDescription {
  if (result.kind !== 'found') throw new Error(`expected found, got ${result.kind}`);
  return result.description;
}

describe('describeNpmPackument: large packuments', () => {
  describe.each(fixtures)('$name', ({ text, headers }) => {
    it('stages the body and yields the whole-parse version inputs', async () => {
      const bytes = enc.encode(text);
      expect(bytes.length).toBeGreaterThan(NPM_INLINE_PARSE_BYTES);
      const { describeWith, requests, objects } = setup(() => ({ body: bytes, headers }));
      const description = described(await describeWith());
      expect(description.snapshot.stagedBlob).toBe(sha256(bytes));
      expect(objects.size).toBe(1);
      expect(requests).toHaveLength(2);
      const expected = wholeParse(text);
      const members = await drain(description);
      expect(inputsOf(members)).toEqual(expected);
      expect(expected.filter((r) => !r.ok)).toEqual([]);
      expect(description.upstreamComplete).toBe(true);
      const doc = JSON.parse(text) as { 'dist-tags': Json };
      expect(description.distTags).toEqual(doc['dist-tags']);

      const continued = described(await describeWith({ snapshot: description.snapshot }));
      expect(requests).toHaveLength(2);
      expect(continued.snapshot).toEqual(description.snapshot);
      expect(inputsOf(await drain(continued))).toEqual(expected);
      expect(
        (await drain(described(await describeWith({ snapshot: continued.snapshot })))).map(
          (m) => m.ordinal,
        ),
      ).toEqual(members.map((m) => m.ordinal));
    }, 60_000);
  });

  it('keeps document ordinals', async () => {
    const text = fixtures[2]?.text as string;
    const { describeWith } = setup(() => ({ body: text }));
    const members = await drain(described(await describeWith()));
    const keys = Object.keys((JSON.parse(text) as { versions: Json }).versions);
    expect(members).toHaveLength(keys.length);
    for (const member of members) expect(keys[member.ordinal]).toBe(member.version);
    expect(members.some((m) => m.upstreamTime === undefined)).toBe(true);
  });

  it('uses the strong ETag as the snapshot id and sha256 otherwise', async () => {
    const a = setup(() => ({ body: fixtures[0]?.text as string, headers: { etag: '"strong-1"' } }));
    expect(described(await a.describeWith()).snapshot.id).toBe('"strong-1"');
    const bytes = enc.encode(fixtures[2]?.text as string);
    const b = setup(() => ({ body: bytes, headers: { etag: 'W/"weak"' } }));
    expect(described(await b.describeWith()).snapshot.id).toBe(`sha256:${sha256(bytes)}`);
  });

  it('refuses a staging response whose ETag changed', async () => {
    const { describeWith } = setup((_, call) => ({
      body: fixtures[0]?.text as string,
      headers: { etag: call === 1 ? '"a"' : '"b"' },
    }));
    await expect(describeWith()).rejects.toBeInstanceOf(NpmPackumentError);
  });

  it('answers restart when the staged blob is gone', async () => {
    const { describeWith, objects } = setup(() => ({ body: fixtures[1]?.text as string }));
    const description = described(await describeWith());
    objects.clear();
    expect(await describeWith({ snapshot: description.snapshot })).toEqual({ kind: 'restart' });
  });

  it('fails the pass and leaves the description incomplete when staged bytes are corrupt', async () => {
    const { describeWith, objects } = setup(() => ({ body: fixtures[1]?.text as string }));
    const description = described(await describeWith());
    const corrupt = (): void => {
      for (const bytes of objects.values()) {
        const at = bytes.lastIndexOf(0x72);
        bytes[at] = 0x73;
      }
    };
    corrupt();
    await expect(drain(description)).rejects.toBeInstanceOf(SnapshotCorruptError);
    expect(description.upstreamComplete).toBe(false);
    await expect(describeWith({ snapshot: description.snapshot })).rejects.toBeInstanceOf(
      SnapshotCorruptError,
    );
  });
});

describe('describeNpmPackument: inline packuments', () => {
  const small = JSON.stringify(packument(20, 10, (i) => `1.0.${i}`));

  it('parses a body up to 1 MiB once with a sha256 id that continuations repeat', async () => {
    const { describeWith, requests, objects } = setup(() => ({ body: small }));
    const description = described(await describeWith());
    expect(description.snapshot).toEqual({ id: `sha256:${sha256(enc.encode(small))}` });
    expect(objects.size).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).toEqual({ accept: 'application/json' });
    expect(inputsOf(await drain(description))).toEqual(wholeParse(small));
    expect(description.upstreamComplete).toBe(true);
    expect(description.validators).toEqual({ 'npm-full': {} });
    const continued = described(await describeWith({ snapshot: description.snapshot }));
    expect(continued.snapshot.id).toBe(description.snapshot.id);
  });

  it('sends validators and answers not_modified on 304', async () => {
    const { describeWith, requests } = setup(() => ({ status: 304, body: null }));
    const result = await describeWith({
      validators: { 'npm-full': { etag: '"e"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' } },
    });
    expect(result).toEqual({ kind: 'not_modified' });
    expect(requests[0]?.headers).toMatchObject({
      'if-none-match': '"e"',
      'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT',
    });
  });

  it('treats a 304 to an unconditional request as an error', async () => {
    const { describeWith } = setup(() => ({ status: 304, body: null }));
    await expect(describeWith()).rejects.toBeInstanceOf(NpmPackumentError);
    await expect(
      describeWith({ snapshot: { id: `sha256:${'0'.repeat(64)}` } }),
    ).rejects.toBeInstanceOf(NpmPackumentError);
  });

  it('is definitive only for a 404 with a JSON body', async () => {
    const json = setup(() => ({ status: 404, body: '{"error":"Not found"}' }));
    expect(await json.describeWith()).toEqual({ kind: 'not_found', definitive: true });
    const html = setup(() => ({ status: 404, body: '<html>nope</html>' }));
    expect(await html.describeWith()).toEqual({ kind: 'not_found', definitive: false });
    const empty = setup(() => ({ status: 404, body: null }));
    expect(await empty.describeWith()).toEqual({ kind: 'not_found', definitive: false });
  });

  it.each([401, 403, 410, 500, 503])('throws on status %i', async (status) => {
    const { describeWith } = setup(() => ({ status, body: '{}' }));
    await expect(describeWith()).rejects.toBeInstanceOf(UpstreamError);
  });

  it('rejects a document that is not an object or has duplicate keys', async () => {
    for (const body of ['[]', '{"versions":{"1.0.0":{},"1.0.0":{}}}', '{"versions":']) {
      const { describeWith } = setup(() => ({ body }));
      await expect(describeWith()).rejects.toThrow();
    }
  });
});

describe('describeNpmPackument: round 2', () => {
  const large = (): string => fixtures[1]?.text as string;

  it('reports the pass-2 validators when pass 2 turns the strong ETag weak', async () => {
    const { describeWith } = setup((_, call) => ({
      body: large(),
      headers: {
        etag: call === 1 ? '"same"' : 'W/"same"',
        'last-modified': 'Tue, 02 Jan 2024 00:00:00 GMT',
      },
    }));
    const description = described(await describeWith());
    expect(description.snapshot.id).toBe(`sha256:${sha256(enc.encode(large()))}`);
    expect(description.validators).toEqual({
      'npm-full': { etag: 'W/"same"', lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT' },
    });
  });

  it('fails unstable when pass 2 disagrees with the first response on Last-Modified', async () => {
    const { describeWith } = setup((_, call) => ({
      body: large(),
      headers: {
        etag: '"same"',
        'last-modified':
          call === 1 ? 'Mon, 01 Jan 2024 00:00:00 GMT' : 'Tue, 02 Jan 2024 00:00:00 GMT',
      },
    }));
    await expect(describeWith()).rejects.toMatchObject({ code: 'unstable' });
  });

  it('fails unstable when the staging passes disagree on validators', async () => {
    const { describeWith } = setup((_, call) => ({
      body: large(),
      headers: { 'last-modified': `Mon, 0${call} Jan 2024 00:00:00 GMT` },
    }));
    await expect(describeWith()).rejects.toMatchObject({ code: 'unstable' });
  });

  it.each([
    ['too long', `"${'a'.repeat(255)}"`],
    ['not printable ASCII', '"caf\u00e9"'],
  ])('falls back to sha256 when the strong ETag is %s', async (_, etag) => {
    const bytes = enc.encode(JSON.stringify(packument(3, 1, (i) => `1.0.${i}`)));
    const { describeWith } = setup(() => ({ body: bytes, headers: { etag } }));
    expect(described(await describeWith()).snapshot.id).toBe(`sha256:${sha256(bytes)}`);
  });

  it('counts every upstream byte once, including 404 bodies', async () => {
    const counted = (): { add(value?: number): void; total: number } => {
      const counter = {
        total: 0,
        add(value = 1) {
          counter.total += value;
        },
      };
      return counter;
    };
    const inline = JSON.stringify(packument(3, 1, (i) => `1.0.${i}`));
    const a = counted();
    await setup(() => ({ body: inline }), { onUpstreamBytes: a }).describeWith();
    expect(a.total).toBe(enc.encode(inline).length);
    const b = counted();
    await setup(() => ({ status: 404, body: '{"error":"x"}' }), {
      onUpstreamBytes: b,
    }).describeWith();
    expect(b.total).toBe(13);
    const c = counted();
    const size = enc.encode(large()).length;
    await setup(() => ({ body: large() }), { onUpstreamBytes: c }).describeWith();
    expect(c.total).toBe(2 * size);
  });

  it.each(['null', '[]', '"text"', '1'])(
    'treats a 404 with JSON %s as not definitive',
    async (body) => {
      const { describeWith } = setup(() => ({ status: 404, body }));
      expect(await describeWith()).toEqual({ kind: 'not_found', definitive: false });
    },
  );

  it('keeps a __proto__ dist-tag', async () => {
    const body = `{"name":"example","dist-tags":{"__proto__":"1.0.0","latest":"1.0.0"},"versions":{"1.0.0":${JSON.stringify(manifest('1.0.0', 0, 1))}}}`;
    const { describeWith } = setup(() => ({ body }));
    const tags = described(await describeWith()).distTags ?? {};
    expect(Object.hasOwn(tags, '__proto__')).toBe(true);
    expect(tags['__proto__']).toBe('1.0.0');
  });

  it('stops a staged pass when the signal aborts between members', async () => {
    const controller = new AbortController();
    const { describeWith } = setup(() => ({ body: large() }), { signal: controller.signal });
    const description = described(await describeWith());
    const seen: VersionCandidate[] = [];
    await expect(
      (async () => {
        for await (const member of description.members) {
          seen.push(member);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
    expect(description.upstreamComplete).toBe(false);
  });
});

describe('describeNpmPackument: round 3', () => {
  it('reads a time map over 1 MiB from a staged document', async () => {
    const doc = packument(30, 10, (i) => `1.0.${i}`) as { time: Json };
    for (let index = 0; index < 40_000; index += 1) {
      doc.time[`0.0.${index}-padding.${index}`] = '2020-01-02T00:00:00.000Z';
    }
    const text = JSON.stringify(doc);
    expect(JSON.stringify(doc.time).length).toBeGreaterThan(NPM_INLINE_PARSE_BYTES);
    const { describeWith } = setup(() => ({ body: text }));
    const description = described(await describeWith());
    expect(description.snapshot.stagedBlob).toBeDefined();
    const members = await drain(description);
    expect(members.every((m) => m.upstreamTime !== undefined || m.ordinal % 5 === 0)).toBe(true);
    expect(inputsOf(members)).toEqual(wholeParse(text));
  });

  it('falls back to sha256 of the staged body when staging turns the strong ETag weak', async () => {
    const before = sameLength(fixtures[0]?.text as string);
    const after = enc.encode(fixtures[0]?.text as string);
    const { describeWith } = setup((_, call) =>
      call === 1
        ? { body: before, headers: { etag: '"a"' } }
        : { body: after, headers: { etag: 'W/"a"' } },
    );
    const description = described(await describeWith());
    expect(description.snapshot.id).toBe(`sha256:${sha256(after)}`);
    expect(description.snapshot.stagedBlob).toBe(sha256(after));
    expect(inputsOf(await drain(description))).toEqual(wholeParse(fixtures[0]?.text as string));
  });

  it('reports the staged validators again on a continuation', async () => {
    const headers = { etag: '"strong-1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
    const { describeWith, requests } = setup(() => ({
      body: fixtures[0]?.text as string,
      headers,
    }));
    const description = described(await describeWith());
    expect(description.snapshot.id).toBe('"strong-1"');
    const expected = {
      'npm-full': { etag: '"strong-1"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    };
    expect(description.validators).toEqual(expected);
    const persisted = JSON.parse(JSON.stringify(description.snapshot)) as SnapshotRef;
    const continued = described(await describeWith({ snapshot: persisted }));
    expect(requests).toHaveLength(2);
    expect(continued.validators).toEqual(expected);
    expect(continued.snapshot.id).toBe(description.snapshot.id);
  });
});

describe('versionChunks', () => {
  it('groups members into chunks of at most 50', async () => {
    const text = JSON.stringify(packument(120, 1, (i) => `1.0.${i}`));
    const { describeWith } = setup(() => ({ body: text }));
    const sizes: number[] = [];
    for await (const chunk of versionChunks(described(await describeWith()).members)) {
      sizes.push(chunk.length);
    }
    expect(sizes).toEqual([50, 50, 20]);
  });
});

describe('describeNpmPackument: first response as pass 1', () => {
  const big = JSON.stringify(packument(1700, 1600, (i) => `4.${i % 13}.${i}`));
  const bigBytes = enc.encode(big);

  function spiedBody(bytes: Uint8Array, onPull?: (offset: number) => void) {
    const reasons: unknown[] = [];
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          onPull?.(offset);
          if (offset >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.slice(offset, offset + 65_536));
            offset += 65_536;
          }
        },
        cancel(reason) {
          reasons.push(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return { body, reasons };
  }

  it('fetches a 3 MiB packument twice and stages sha256 of the whole body', async () => {
    expect(bigBytes.length).toBeGreaterThan(3 * 1024 * 1024);
    const { describeWith, requests, objects } = setup(() => ({ body: bigBytes }));
    const description = described(await describeWith());
    expect(requests).toHaveLength(2);
    expect(description.snapshot.stagedBlob).toBe(sha256(bigBytes));
    expect([...objects.values()][0]).toEqual(bigBytes);
    expect(inputsOf(await drain(description))).toEqual(wholeParse(big));
  }, 60_000);

  it('fetches a 100 KiB packument once', async () => {
    const text = JSON.stringify(packument(60, 1500, (i) => `1.0.${i}`));
    expect(enc.encode(text).length).toBeGreaterThan(100 * 1024);
    expect(enc.encode(text).length).toBeLessThan(NPM_INLINE_PARSE_BYTES);
    const { describeWith, requests } = setup(() => ({ body: text }));
    described(await describeWith());
    expect(requests).toHaveLength(1);
  });

  it('retries through a new request when pass 2 differs from the first response', async () => {
    const after = enc.encode(fixtures[0]?.text as string);
    const { describeWith, requests } = setup((_, call) => ({
      body: call === 1 ? sameLength(fixtures[0]?.text as string) : after,
    }));
    const description = described(await describeWith());
    expect(requests).toHaveLength(4);
    expect(description.snapshot.stagedBlob).toBe(sha256(after));
  });

  it('fails unstable when retry pass 1 changes validators after attempt 1 pass 2', async () => {
    const original = fixtures[0]?.text as string;
    const { describeWith, requests, objects } = setup((_, call) => ({
      body: call === 1 ? sameLength(original) : original,
      headers: {
        'last-modified':
          call <= 2 ? 'Mon, 01 Jan 2024 00:00:00 GMT' : 'Tue, 02 Jan 2024 00:00:00 GMT',
      },
    }));
    await expect(describeWith()).rejects.toMatchObject({ code: 'unstable' });
    expect(requests).toHaveLength(3);
    expect(objects.size).toBe(0);
  });

  it('fails without retry when pass 2 changes size from the first response', async () => {
    const original = fixtures[0]?.text as string;
    const { describeWith, requests, objects } = setup((_, call) => ({
      body: call === 1 ? original : `${original} `,
    }));
    await expect(describeWith()).rejects.toBeInstanceOf(BlobSizeMismatchError);
    expect(requests).toHaveLength(2);
    expect(objects.size).toBe(0);
  });

  it('counts downloaded head bytes when aborted on the threshold-crossing chunk', async () => {
    const controller = new AbortController();
    let downloaded = 0;
    let total = 0;
    const first = spiedBody(bigBytes, (offset) => {
      downloaded += Math.min(65_536, bigBytes.length - offset);
      if (downloaded > NPM_INLINE_PARSE_BYTES) controller.abort();
    });
    let requests = 0;
    const fetch: PolicyFetch = async () => {
      requests += 1;
      return { status: 200, headers: new Headers(), body: first.body };
    };
    const { store } = memoryStore();
    const error = await describeNpmPackument(
      {
        ctx,
        fetch,
        store,
        codecs,
        signal: controller.signal,
        onUpstreamBytes: { add: (n = 1) => void (total += n) },
      },
      { name: 'example', url: URL_ },
      {},
    ).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(downloaded).toBe(NPM_INLINE_PARSE_BYTES + 65_536);
    expect(total).toBe(downloaded);
    expect(first.reasons).toHaveLength(1);
    expect(requests).toBe(1);
  });

  it('throws UpstreamUnstableError when the bytes keep changing', async () => {
    const { describeWith, requests } = setup((_, call) => ({
      body:
        call % 2 === 1 ? sameLength(fixtures[0]?.text as string) : (fixtures[0]?.text as string),
    }));
    await expect(describeWith()).rejects.toBeInstanceOf(UpstreamUnstableError);
    expect(requests).toHaveLength(4);
  });

  it('cancels the first response body when aborted during pass 1', async () => {
    const controller = new AbortController();
    const first = spiedBody(bigBytes, (offset) => {
      if (offset >= 2 * 1024 * 1024) controller.abort();
    });
    const requests: UpstreamRequest[] = [];
    const fetch: PolicyFetch = async (request) => {
      requests.push(request);
      return { status: 200, headers: new Headers(), body: first.body };
    };
    const { store } = memoryStore();
    const error = await describeNpmPackument(
      { ctx, fetch, store, codecs, signal: controller.signal },
      { name: 'example', url: URL_ },
      {},
    ).catch((e: unknown) => e);
    expect(controller.signal.aborted).toBe(true);
    expect(error).toBe(controller.signal.reason);
    expect(first.reasons).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
});

describe('describeNpmPackument: oversized version manifests', () => {
  const MiB = 1024 * 1024;

  function oversized(): string {
    const doc = packument(3, 10, (i) => `1.0.${i}`) as { versions: Record<string, Json> };
    doc.versions['1.0.0'] = manifest('1.0.0', 0, 10, { readme: 'x'.repeat(2 * MiB) });
    return JSON.stringify(doc);
  }

  it('skips a 2 MiB manifest, yields the other versions and records the skip', async () => {
    const text = oversized();
    const { describeWith } = setup(() => ({ body: text, headers: { etag: '"big-1"' } }));
    const description = described(await describeWith());
    expect(description.snapshot.stagedBlob).toBeDefined();
    const members = await drain(description);
    expect(members.map((m) => m.version)).toEqual(['1.0.1', '1.0.2']);
    expect(members.map((m) => m.ordinal)).toEqual([1, 2]);
    expect(description.skippedMembers).toEqual([{ version: '1.0.0', reason: 'member_too_large' }]);
    expect(description.upstreamComplete).toBe(false);

    const continued = described(await describeWith({ snapshot: description.snapshot }));
    expect((await drain(continued)).map((m) => m.version)).toEqual(['1.0.1', '1.0.2']);
    expect(continued.skippedMembers).toEqual([{ version: '1.0.0', reason: 'member_too_large' }]);
    expect(continued.upstreamComplete).toBe(false);
  }, 60_000);

  it('reports an incomplete set when every version manifest is oversized', async () => {
    const doc = packument(1, 10, () => '1.0.0') as { versions: Record<string, Json> };
    doc.versions['1.0.0'] = manifest('1.0.0', 0, 10, { readme: 'x'.repeat(2 * MiB) });
    const { describeWith } = setup(() => ({ body: JSON.stringify(doc) }));
    const description = described(await describeWith());
    expect(await drain(description)).toEqual([]);
    expect(description.skippedMembers).toEqual([{ version: '1.0.0', reason: 'member_too_large' }]);
    expect(description.upstreamComplete).toBe(false);
  }, 60_000);

  it('keeps document ordinals when an oversized manifest is in the middle', async () => {
    const doc = packument(3, 10, (i) => `1.0.${i}`) as { versions: Record<string, Json> };
    doc.versions['1.0.1'] = manifest('1.0.1', 1, 10, { readme: 'x'.repeat(2 * MiB) });
    for (const chunkSize of [4096, 4 * MiB]) {
      const { store } = memoryStore(chunkSize);
      const { fetch } = fakeFetch(() => ({ body: JSON.stringify(doc) }));
      const description = described(
        await describeNpmPackument(
          { ctx, store, fetch, codecs },
          { name: 'example', url: URL_ },
          {},
        ),
      );
      const members = await drain(description);
      expect(members.map((m) => m.version)).toEqual(['1.0.0', '1.0.2']);
      expect(members.map((m) => m.ordinal)).toEqual([0, 2]);
      expect(description.skippedMembers).toEqual([
        { version: '1.0.1', reason: 'member_too_large' },
      ]);
      expect(description.upstreamComplete).toBe(false);
    }
  }, 60_000);

  it('has no skipped members and stays complete without an oversized manifest', async () => {
    const text = fixtures[0]?.text as string;
    const { describeWith } = setup(() => ({ body: text }));
    const description = described(await describeWith());
    await drain(description);
    expect(description.skippedMembers).toEqual([]);
    expect(description.upstreamComplete).toBe(true);
  }, 60_000);

  it('has no skipped members for an inline packument', async () => {
    const { describeWith } = setup(() => ({
      body: JSON.stringify(packument(3, 10, (i) => `1.0.${i}`)),
    }));
    const description = described(await describeWith());
    await drain(description);
    expect(description.skippedMembers).toEqual([]);
    expect(description.upstreamComplete).toBe(true);
  });

  it('still fails the describe on a time map over 8 MiB', async () => {
    const doc = packument(3, 10, (i) => `1.0.${i}`) as { time: Json };
    for (let index = 0; index < 270_000; index += 1) {
      doc.time[`0.0.${index}-padding.${index}`] = '2020-01-02T00:00:00.000Z';
    }
    const text = JSON.stringify(doc);
    expect(JSON.stringify(doc.time).length).toBeGreaterThan(8 * MiB);
    const { describeWith } = setup(() => ({ body: text }));
    const error = await describeWith().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as { code?: unknown }).code).toBe('member_too_large');
  }, 60_000);
});

describe('describeNpmPackument: absence fails closed', () => {
  const notFound = '{"error":"Not found"}';
  const definitiveOf = async (
    reply: Reply,
    target: Partial<NpmPackumentTarget> = {},
  ): Promise<boolean> => {
    const result = await setup(() => ({ status: 404, ...reply }), {}, target).describeWith();
    if (result.kind !== 'not_found') throw new Error(`expected not_found, got ${result.kind}`);
    return result.definitive;
  };

  it('is definitive for the documented body on the expected url', async () => {
    expect(await definitiveOf({ body: notFound })).toBe(true);
  });

  it.each([
    ['an empty object', '{}'],
    ['a message member', '{"message":"gone"}'],
    ['another error text', '{"error":"Bad gateway"}'],
    ['a non-string error', '{"error":404}'],
    ['extra members', '{"error":"Not found","hint":"proxy"}'],
    ['a different case', '{"error":"not found"}'],
    ['an array', '[{"error":"Not found"}]'],
  ])('is not definitive for a 404 body with %s', async (_, body) => {
    expect(await definitiveOf({ body })).toBe(false);
  });

  it('is not definitive after a redirect to the documented not-found body', async () => {
    expect(await definitiveOf({ body: notFound, redirected: true })).toBe(false);
  });

  it('is not definitive for a credentialed npmjs 404 with the documented body', async () => {
    expect(
      await definitiveOf(
        { body: notFound, redirected: false },
        {
          credential: {
            origins: ['https://registry.npmjs.org'],
            queryParams: [],
            apply: (headers, url) => ({ headers, url }),
          },
        },
      ),
    ).toBe(false);
  });

  it('is not definitive without redirect information', async () => {
    const result = await describeNpmPackument(
      {
        ctx,
        fetch: async () => ({
          status: 404,
          headers: new Headers(),
          body: streamOf(enc.encode(notFound)),
        }),
        store: memoryStore().store,
        codecs,
      },
      { name: 'example', url: URL_ },
      {},
    );
    expect(result).toEqual({ kind: 'not_found', definitive: false });
  });

  it.each([
    'https://npm.pkg.github.com',
    'https://verdaccio.example.test',
    'https://artifactory.example.test',
  ])('is not definitive for another registry %s', async (registry) => {
    expect(await definitiveOf({ body: notFound }, { url: `${registry}/example` })).toBe(false);
  });
});

describe('describeNpmPackument: mixed-value time maps', () => {
  it.each([
    ['inline', false],
    ['staged', true],
  ])('preserves valid timestamps in a mixed-value time map (%s)', async (_, staged) => {
    const firstTime = '2021-01-02T03:04:05.000Z';
    const secondTime = '2022-02-03T04:05:06.000Z';
    const body = JSON.stringify({
      name: 'example',
      versions: {
        '1.0.0': manifest('1.0.0', 0, 1),
        '2.0.0': manifest('2.0.0', 1, 1),
        '3.0.0': manifest('3.0.0', 2, 1),
      },
      time: {
        '1.0.0': firstTime,
        created: null,
        modified: false,
        unpublished: {},
        other: [],
        '3.0.0': 123,
        '2.0.0': secondTime,
      },
      'dist-tags': { latest: '2.0.0' },
      ...(staged ? { padding: 'x'.repeat(NPM_INLINE_PARSE_BYTES) } : {}),
    });
    const { describeWith } = setup(() => ({ body }));
    const description = described(await describeWith());
    expect(description.snapshot.stagedBlob !== undefined).toBe(staged);
    const expected = [
      { version: '1.0.0', upstreamTime: firstTime },
      { version: '2.0.0', upstreamTime: secondTime },
      { version: '3.0.0', upstreamTime: undefined },
    ];
    const timestamps = (members: readonly VersionCandidate[]) =>
      members.map(({ version, upstreamTime }) => ({ version, upstreamTime }));
    expect(timestamps(await drain(description))).toEqual(expected);
    expect(description.upstreamComplete).toBe(true);
    expect(description.distTags).toEqual({ latest: '2.0.0' });
    if (staged) {
      const continued = described(await describeWith({ snapshot: description.snapshot }));
      expect(timestamps(await drain(continued))).toEqual(expected);
      expect(continued.upstreamComplete).toBe(true);
    }
  });
});

describe('describeNpmPackument: dist-tag authority', () => {
  describe.each([
    ['inline', false],
    ['staged', true],
  ])('%s', (_, staged) => {
    const read = async (tags: unknown): Promise<PackageDescription> => {
      const body = JSON.stringify({
        name: 'example',
        versions: { '1.0.0': manifest('1.0.0', 0, 1) },
        ...(tags === undefined ? {} : { 'dist-tags': tags }),
        ...(staged ? { padding: 'x'.repeat(NPM_INLINE_PARSE_BYTES) } : {}),
      });
      const description = described(await setup(() => ({ body })).describeWith());
      await drain(description);
      expect(description.upstreamComplete).toBe(true);
      return description;
    };

    it.each([
      ['missing', undefined],
      ['null', null],
      ['array', []],
      ['string', 'latest'],
      ['number', 1],
      ['boolean', false],
      ['mixed map with null', { latest: null, next: '2.0.0' }],
      ['mixed map with array', { latest: [], next: '2.0.0' }],
      ['mixed map with object', { latest: {}, next: '2.0.0' }],
      ['mixed map with number', { latest: 1, next: '2.0.0' }],
      ['mixed map with boolean', { latest: false, next: '2.0.0' }],
      ['mixed map with invalid value last', { next: '2.0.0', latest: null }],
    ])('preserves seeded tags when dist-tags is %s', async (_, upstreamTags) => {
      let storedTags: Readonly<Record<string, string>> = {
        latest: '1.0.0',
        next: '2.0.0-beta.1',
      };
      const replaceTags = vi.fn((tags: Readonly<Record<string, string>>) => {
        storedTags = tags;
      });
      const description = await read(upstreamTags);
      // The replacement plan accepts only an authoritative map; undefined skips tag writes.
      if (description.distTags !== undefined) replaceTags(description.distTags);
      expect(storedTags).toEqual({ latest: '1.0.0', next: '2.0.0-beta.1' });
      expect(replaceTags).not.toHaveBeenCalled();
      expect(description.distTags).toBeUndefined();
    });

    it.each([{}, { latest: '1.0.0' }])('retains an authoritative map %j', async (tags) => {
      const description = await read(tags);
      expect(description.distTags).toEqual(tags);
      expect(Object.hasOwn(description, 'distTags')).toBe(true);
    });
  });
});

describe('describeNpmPackument: completeness fails closed', () => {
  const doc = (versions: unknown, extra: Json = {}): string =>
    JSON.stringify({
      name: 'example',
      'dist-tags': {},
      ...(versions === undefined ? {} : { versions }),
      ...extra,
    });
  const one = { '1.0.0': manifest('1.0.0', 0, 1) };
  const invalid = async (text: string, staged = false): Promise<void> => {
    const body = staged
      ? text.replace('"dist-tags"', `"padding":"${'x'.repeat(NPM_INLINE_PARSE_BYTES)}","dist-tags"`)
      : text;
    const { describeWith } = setup(() => ({ body }));
    const run = async (): Promise<unknown> => {
      const result = await describeWith();
      if (result.kind === 'found') await drain(result.description);
      return result;
    };
    await expect(run()).rejects.toMatchObject({
      name: 'NpmPackumentError',
      code: 'invalid',
      packageKey: 'example',
    });
  };

  it('accepts a valid packument inline and staged', async () => {
    for (const staged of [false, true]) {
      const text = doc(one);
      const body = staged
        ? text.replace(
            '"dist-tags"',
            `"padding":"${'x'.repeat(NPM_INLINE_PARSE_BYTES)}","dist-tags"`,
          )
        : text;
      const description = described(await setup(() => ({ body })).describeWith());
      expect((await drain(description)).map((m) => m.version)).toEqual(['1.0.0']);
      expect(description.upstreamComplete).toBe(true);
    }
  });

  describe.each([
    ['inline', false],
    ['staged', true],
  ])('%s', (_, staged) => {
    it.each([true, false])(
      'recognizes an unpublished package with time first: %s',
      async (timeFirst) => {
        const name = { name: 'example' };
        const time = {
          time: { unpublished: { time: '2026-10-17T00:00:00.000Z', versions: ['1.0.0'] } },
        };
        const text = JSON.stringify({
          ...(timeFirst ? { ...time, ...name } : { ...name, ...time }),
          ...(staged ? { padding: 'x'.repeat(NPM_INLINE_PARSE_BYTES) } : {}),
        });
        const { describeWith, objects } = setup(() => ({ body: text }));
        await expect(describeWith()).resolves.toEqual({ kind: 'not_found', definitive: true });
        expect(objects.size).toBe(staged ? 1 : 0);
      },
    );

    it('never makes a redirected unpublished response definitive', async () => {
      const text = doc(undefined, { time: { unpublished: {} } });
      const body = staged
        ? text.replace(
            '"dist-tags"',
            `"padding":"${'x'.repeat(NPM_INLINE_PARSE_BYTES)}","dist-tags"`,
          )
        : text;
      await expect(setup(() => ({ body, redirected: true })).describeWith()).resolves.toEqual({
        kind: 'not_found',
        definitive: false,
      });
    });

    it('never makes another registry unpublished response definitive', async () => {
      const text = doc(undefined, { time: { unpublished: {} } });
      const body = staged
        ? text.replace(
            '"dist-tags"',
            `"padding":"${'x'.repeat(NPM_INLINE_PARSE_BYTES)}","dist-tags"`,
          )
        : text;
      await expect(
        setup(() => ({ body }), {}, { url: 'https://npm.pkg.github.com/example' }).describeWith(),
      ).resolves.toEqual({ kind: 'not_found', definitive: false });
    });

    it.each([null, [], 'gone', true])(
      'rejects a non-object unpublished marker %j',
      async (unpublished) => {
        await invalid(doc(undefined, { time: { unpublished } }), staged);
      },
    );

    it.each([{}, null, []])(
      'rejects a versions field %j despite an unpublished marker',
      async (versions) => {
        await invalid(doc(versions, { time: { unpublished: {} } }), staged);
      },
    );

    it('rejects an unpublished document with a mismatched name', async () => {
      await invalid(doc(undefined, { name: 'other', time: { unpublished: {} } }), staged);
    });

    it('rejects a document without versions', async () => {
      await invalid(doc(undefined), staged);
    });
    it.each([
      ['an array', []],
      ['a string', 'x'],
      ['null', null],
      ['a number', 3],
    ])('rejects versions that is %s', async (_n, versions) => {
      await invalid(doc(versions), staged);
    });
    it('rejects an empty versions object', async () => {
      await invalid(doc({}), staged);
    });
    it('rejects a version key that differs from its version', async () => {
      await invalid(doc({ ...one, '2.0.0': manifest('2.0.1', 1, 1) }), staged);
    });
    it('rejects a version member that is not an object', async () => {
      await invalid(doc({ ...one, '2.0.0': null }), staged);
      await invalid(doc({ ...one, '2.0.0': [] }), staged);
    });
    it('rejects a missing name', async () => {
      const parsed = JSON.parse(doc(one)) as Json;
      delete parsed.name;
      await invalid(JSON.stringify(parsed), staged);
    });
    it('rejects a name that is not the requested package', async () => {
      await invalid(doc(one, { name: 'other' }), staged);
      await invalid(doc(one, { name: 5 }), staged);
    });
  });

  it('never reports a partial set as complete when a later version is malformed', async () => {
    const text = doc({ ...one, '2.0.0': manifest('9.9.9', 1, 1) });
    const result = await setup(() => ({ body: text }))
      .describeWith()
      .catch((e: unknown) => e);
    if (result instanceof Error) return;
    const description = described(result as NpmDescribeResult);
    await drain(description).catch(() => undefined);
    expect(description.upstreamComplete).toBe(false);
  });
});

describe('staged unpublished evidence', () => {
  const body = JSON.stringify({
    name: 'example',
    time: { unpublished: {} },
    padding: 'x'.repeat(NPM_INLINE_PARSE_BYTES),
  });

  it.each([1, 2])('fails closed when fetch %i was redirected', async (redirectedCall) => {
    const { describeWith } = setup((_, call) => ({ body, redirected: call === redirectedCall }));
    await expect(describeWith()).resolves.toEqual({ kind: 'not_found', definitive: false });
  });

  it.each([3, 4])('fails closed when retry fetch %i was redirected', async (redirectedCall) => {
    const { describeWith, requests } = setup((_, call) => ({
      body: call === 1 ? body.replace('"unpublished":{}', '"unpublished":[]') : body,
      redirected: call === redirectedCall,
    }));
    await expect(describeWith()).resolves.toEqual({ kind: 'not_found', definitive: false });
    expect(requests).toHaveLength(4);
  });

  it('never makes a credentialed continuation definitive despite persisted evidence', async () => {
    const { store } = memoryStore();
    const ref = await stageSnapshot(ctx, async () => streamOf(enc.encode(body)), store, {
      codecs,
      maxBytes: 32 * 1024 * 1024,
    });
    await expect(
      describeNpmPackument(
        {
          ctx,
          store,
          codecs,
          fetch: async () => {
            throw new Error('continuation must not fetch');
          },
        },
        {
          name: 'example',
          url: URL_,
          credential: {
            origins: ['https://registry.npmjs.org'],
            queryParams: [],
            apply: (headers, url) => ({ headers, url }),
          },
        },
        { snapshot: { ...ref, definitiveAbsence: true } as NpmSnapshotRef },
      ),
    ).resolves.toEqual({ kind: 'not_found', definitive: false });
  });

  it.each([true, false, undefined])(
    'preserves staged absence evidence %s on continuation',
    async (definitiveAbsence) => {
      const { store } = memoryStore();
      const ref = await stageSnapshot(ctx, async () => streamOf(enc.encode(body)), store, {
        codecs,
        maxBytes: 32 * 1024 * 1024,
      });
      const fetch: PolicyFetch = async () => {
        throw new Error('continuation must not fetch');
      };
      const persisted = JSON.parse(JSON.stringify({ ...ref, definitiveAbsence })) as SnapshotRef;
      await expect(
        describeNpmPackument(
          { ctx, fetch, store, codecs },
          { name: 'example', url: URL_ },
          { snapshot: persisted },
        ),
      ).resolves.toEqual({ kind: 'not_found', definitive: definitiveAbsence === true });
    },
  );
});

describe('NpmPackumentError package context', () => {
  it('carries the canonical package key without adding it to the error message', async () => {
    const run = setup(
      () => ({ body: '{"name":"LegacyName"}' }),
      {},
      { name: 'LegacyName' },
    ).describeWith();
    await expect(run).rejects.toMatchObject({
      code: 'invalid',
      packageKey: '!legacy!name',
      message: 'npm packument invalid',
    });
  });

  it('carries the package key for an empty 200 body', async () => {
    await expect(setup(() => ({ body: null })).describeWith()).rejects.toMatchObject({
      code: 'invalid',
      packageKey: 'example',
      message: 'npm packument invalid',
    });
  });
});
