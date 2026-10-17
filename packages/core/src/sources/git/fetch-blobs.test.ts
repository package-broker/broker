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
import { createPolicyFetch, type PolicyFetch } from '../policy-fetch.js';
import { createOutboundPolicy } from '../url-policy.js';
import {
  GitFetchError,
  MAX_BLOB_BATCH,
  MAX_OBJECT_BYTES,
  createGitBlobReader,
  type GitFetchContext,
} from './fetch.js';
import { FLUSH, encodePkt } from './pkt-line.js';

const enc = new TextEncoder();
const KIB = 1024;
const MIB = 1024 * KIB;
const RESULT = 'application/x-git-upload-pack-result';
const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });

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

interface Obj {
  type: 'tree' | 'blob';
  data: Uint8Array;
  oid: string;
}

const blobId = (type: string, data: Uint8Array): string =>
  createHash('sha1')
    .update(enc.encode(`${type} ${data.length}\0`))
    .update(data)
    .digest('hex');

const makeObj = (type: Obj['type'], data: Uint8Array): Obj => ({
  type,
  data,
  oid: blobId(type, data),
});

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

function buildPack(objects: Obj[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(enc.encode('PACK'));
  const dv = new DataView(header.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  const body = concat([
    header,
    ...objects.flatMap((o) => [
      packHeader(o.type === 'tree' ? 2 : 3, o.data.length),
      new Uint8Array(deflateSync(o.data, { level: 1 })),
    ]),
  ]);
  return concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
}

function fetchResponse(pack: Uint8Array): Uint8Array {
  const bands: Uint8Array[] = [];
  for (let at = 0; at < pack.length; at += 65_000) {
    bands.push(encodePkt(concat([Uint8Array.of(1), pack.subarray(at, at + 65_000)])));
  }
  return concat([encodePkt('packfile\n'), ...bands, FLUSH]);
}

function wantsOf(body: Uint8Array): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < body.length) {
    const len = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
    if (len < 4) {
      at += 4;
      continue;
    }
    const line = new TextDecoder().decode(body.subarray(at + 4, at + len)).trimEnd();
    if (line.startsWith('want ')) out.push(line.slice(5));
    expect(line.startsWith('filter') || line.startsWith('deepen')).toBe(false);
    at += len;
  }
  return out;
}

class FakeRemote {
  readonly objects = new Map<string, Obj>();
  readonly requests: string[][] = [];
  readonly substitute = new Map<string, Obj>();
  extra: ((request: number) => Obj[]) | undefined;

  add(obj: Obj): Obj {
    this.objects.set(obj.oid, obj);
    return obj;
  }

  policyFetch(): PolicyFetch {
    return createPolicyFetch({
      policy,
      userAgent: 'package-broker-test',
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe('https://blobs.example.com/acme/lib.git/git-upload-pack');
        const wants = wantsOf(init?.body as Uint8Array);
        this.requests.push(wants);
        const picked = new Map<string, Obj>();
        for (const want of wants) {
          const obj = this.substitute.get(want) ?? this.objects.get(want);
          if (obj) picked.set(obj.oid, obj);
        }
        for (const obj of this.extra?.(this.requests.length) ?? []) picked.set(obj.oid, obj);
        return new Response(fetchResponse(buildPack([...picked.values()])), {
          headers: { 'content-type': RESULT },
        });
      },
    });
  }
}

const REPO = 'https://blobs.example.com/acme/lib.git';
const ctx = (fake: FakeRemote, runtime: 'docker' | 'cloudflare' = 'docker'): GitFetchContext => ({
  policyFetch: fake.policyFetch(),
  codecs,
  runtime,
});

const smallBlobs = (fake: FakeRemote, count: number, tag = 'f'): Obj[] =>
  Array.from({ length: count }, (_, n) => fake.add(makeObj('blob', enc.encode(`${tag} ${n}\n`))));

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return chunks;
}

async function readAll(
  reader: ReturnType<typeof createGitBlobReader>,
  oid: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const { size, body } = await reader.read(oid, maxBytes);
  const bytes = concat(await drain(body));
  expect(bytes.length).toBe(size);
  return bytes;
}

describe('createGitBlobReader', () => {
  it('exports the batch and object caps', () => {
    expect(MAX_BLOB_BATCH).toBe(256);
    expect(MAX_OBJECT_BYTES).toBe(8 * MIB);
  });

  it('serves 600 blobs read in plan order in batches of 256, 256 and 88', async () => {
    const fake = new FakeRemote();
    const blobs = smallBlobs(fake, 600);
    const plan = blobs.map((b) => b.oid);
    const reader = createGitBlobReader(ctx(fake), REPO, plan);
    for (const blob of blobs) {
      expect(await readAll(reader, blob.oid)).toEqual(blob.data);
    }
    expect(fake.requests.map((r) => r.length)).toEqual([256, 256, 88]);
    expect(fake.requests).toEqual([plan.slice(0, 256), plan.slice(256, 512), plan.slice(512)]);
  });

  it('deduplicates the plan', async () => {
    const fake = new FakeRemote();
    const [a, b] = smallBlobs(fake, 2);
    const reader = createGitBlobReader(ctx(fake), REPO, [a!.oid, a!.oid, b!.oid]);
    await readAll(reader, a!.oid);
    expect(fake.requests).toEqual([[a!.oid, b!.oid]]);
  });

  it('rejects a read with missing_object when the remote answers with other content', async () => {
    const fake = new FakeRemote();
    const [asked, other] = smallBlobs(fake, 2);
    fake.substitute.set(asked!.oid, makeObj('blob', enc.encode('forged content\n')));
    const reader = createGitBlobReader(ctx(fake), REPO, [asked!.oid, other!.oid]);
    await expect(reader.read(asked!.oid, 1024)).rejects.toMatchObject({
      name: 'GitFetchError',
      code: 'missing_object',
      message: 'missing_object',
    });
    expect(await readAll(reader, other!.oid)).toEqual(other!.data);
  });

  it('rejects a blob over the object cap with too_large and serves the rest', async () => {
    const fake = new FakeRemote();
    const big = fake.add(makeObj('blob', new Uint8Array(MAX_OBJECT_BYTES + 1).fill(0x61)));
    const [small] = smallBlobs(fake, 1);
    const reader = createGitBlobReader(ctx(fake), REPO, [big.oid, small!.oid]);
    await expect(reader.read(big.oid, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(await readAll(reader, small!.oid)).toEqual(small!.data);
  });

  it('rejects size over maxBytes with too_large before returning a body', async () => {
    const fake = new FakeRemote();
    const [blob] = smallBlobs(fake, 1);
    const reader = createGitBlobReader(ctx(fake), REPO, [blob!.oid]);
    await expect(reader.read(blob!.oid, blob!.data.length - 1)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(await readAll(reader, blob!.oid, blob!.data.length)).toEqual(blob!.data);
  });

  it('bisects a batch whose pack exceeds the response cap and serves every blob', async () => {
    const fake = new FakeRemote();
    const blobs = Array.from({ length: 9 }, () =>
      fake.add(makeObj('blob', new Uint8Array(randomBytes(7.5 * KIB)))),
    );
    const reader = createGitBlobReader(
      ctx(fake),
      REPO,
      blobs.map((b) => b.oid),
      { limits: { packBytes: 64 * KIB } },
    );
    for (const blob of blobs) {
      const bytes = await readAll(reader, blob.oid);
      expect(blobId('blob', bytes)).toBe(blob.oid);
    }
    expect(fake.requests.map((r) => r.length)).toEqual([9, 4, 5]);
  });

  it('halves the batch window when a batch overflows the retained budget', async () => {
    const fake = new FakeRemote();
    const blobs = Array.from({ length: 9 }, () =>
      fake.add(makeObj('blob', new Uint8Array(randomBytes(7 * KIB)))),
    );
    const reader = createGitBlobReader(
      ctx(fake),
      REPO,
      blobs.map((b) => b.oid),
      { limits: { retainedBytes: 64 * KIB } },
    );
    for (const blob of blobs) {
      expect(await readAll(reader, blob.oid)).toEqual(blob.data);
    }
    expect(fake.requests.map((r) => r.length)).toEqual([9, 4, 4, 1]);
  });

  it('halves the batch window when bisection runs out of requests', async () => {
    const fake = new FakeRemote();
    const [small] = smallBlobs(fake, 1);
    const big = Array.from({ length: 99 }, (_, n) =>
      fake.add(makeObj('blob', new Uint8Array(2 * KIB).fill(n))),
    );
    const reader = createGitBlobReader(ctx(fake), REPO, [small!.oid, ...big.map((b) => b.oid)], {
      limits: { maxObjectBytes: KIB },
    });
    expect(await readAll(reader, small!.oid)).toEqual(small!.data);
    const attempts = fake.requests.filter((r) => r[0] === small!.oid).map((r) => r.length);
    expect(attempts[0]).toBe(100);
    expect(attempts).toContain(50);
    expect(Math.min(...attempts)).toBe(1);
    expect(fake.requests.length).toBeLessThanOrEqual(3 * 65);
    const before = fake.requests.length;
    await expect(reader.read(big[0]!.oid, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(fake.requests.length).toBe(before);
  });

  it('drops returned objects and objects outside the plan', async () => {
    const fake = new FakeRemote();
    const blobs = Array.from({ length: 15 }, () =>
      fake.add(makeObj('blob', new Uint8Array(randomBytes(7 * KIB)))),
    );
    const extras = Array.from({ length: 15 }, () =>
      makeObj('blob', new Uint8Array(randomBytes(7 * KIB))),
    );
    fake.extra = (request) => [extras[request - 1]!];
    const reader = createGitBlobReader(
      ctx(fake),
      REPO,
      blobs.map((b) => b.oid),
      { limits: { retainedBytes: 100 * KIB } },
    );
    for (const blob of [...blobs].reverse()) {
      const { size, body } = await reader.read(blob.oid, Number.MAX_SAFE_INTEGER);
      expect(size).toBe(7 * KIB);
      await body.cancel();
    }
    expect(fake.requests).toEqual([...blobs].reverse().map((b) => [b.oid]));
  });

  it('refetches a blob that was already returned', async () => {
    const fake = new FakeRemote();
    const [a, b] = smallBlobs(fake, 2);
    const reader = createGitBlobReader(ctx(fake), REPO, [a!.oid, b!.oid]);
    expect(await readAll(reader, a!.oid)).toEqual(a!.data);
    expect(await readAll(reader, a!.oid)).toEqual(a!.data);
    expect(await readAll(reader, b!.oid)).toEqual(b!.data);
    expect(fake.requests).toEqual([[a!.oid, b!.oid], [a!.oid]]);
  });

  it('streams chunks of at most 64 KiB that hash to the oid', async () => {
    const fake = new FakeRemote();
    const blob = fake.add(makeObj('blob', new Uint8Array(randomBytes(200 * 1024 + 7))));
    const reader = createGitBlobReader(ctx(fake), REPO, [blob.oid]);
    const { size, body } = await reader.read(blob.oid, blob.data.length);
    const chunks = await drain(body);
    expect(chunks.length).toBe(4);
    expect(chunks.every((c) => c.length > 0 && c.length <= 64 * 1024)).toBe(true);
    const bytes = concat(chunks);
    expect(bytes.length).toBe(size);
    expect(blobId('blob', bytes)).toBe(blob.oid);
  });

  it('rejects a held object of another type with bad_object', async () => {
    const fake = new FakeRemote();
    const tree = fake.add(makeObj('tree', enc.encode('')));
    const reader = createGitBlobReader(ctx(fake), REPO, [tree.oid]);
    await expect(reader.read(tree.oid, 1024)).rejects.toMatchObject({ code: 'bad_object' });
  });

  it('rejects an oid outside the plan with missing_object without a request', async () => {
    const fake = new FakeRemote();
    const [a, b] = smallBlobs(fake, 2);
    const reader = createGitBlobReader(ctx(fake), REPO, [a!.oid]);
    await expect(reader.read(b!.oid, 1024)).rejects.toMatchObject({ code: 'missing_object' });
    expect(fake.requests).toEqual([]);
  });

  it('validates the plan, runtime and repository at creation', () => {
    const fake = new FakeRemote();
    const [a] = smallBlobs(fake, 1);
    for (const bad of ['', 'HEAD', a!.oid.toUpperCase(), `${a!.oid}0`]) {
      expect(() => createGitBlobReader(ctx(fake), REPO, [a!.oid, bad])).toThrow(
        expect.objectContaining({ code: 'bad_ref', message: 'bad_ref' }),
      );
    }
    expect(() => createGitBlobReader(ctx(fake, 'cloudflare'), REPO, [a!.oid])).toThrow(
      expect.objectContaining({ code: 'git_archive_requires_docker' }),
    );
    expect(() =>
      createGitBlobReader(ctx(fake), 'https://user:secret@blobs.example.com/acme/lib.git', [
        a!.oid,
      ]),
    ).toThrow(expect.objectContaining({ code: 'bad_url', message: 'bad_url' }));
    for (const limit of [0, -1, 1.5]) {
      expect(() =>
        createGitBlobReader(ctx(fake), REPO, [a!.oid], { limits: { packBytes: limit } }),
      ).toThrow(TypeError);
    }
    expect(() =>
      createGitBlobReader(ctx(fake), REPO, [a!.oid], { limits: { packBytes: 2 ** 40 } }),
    ).not.toThrow();
    expect(() => createGitBlobReader(ctx(fake), REPO, [a!.oid])).not.toThrow();
    expect(fake.requests).toEqual([]);
  });

  it('rejects a negative or non-integer maxBytes with TypeError', async () => {
    const fake = new FakeRemote();
    const [a] = smallBlobs(fake, 1);
    const reader = createGitBlobReader(ctx(fake), REPO, [a!.oid]);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(reader.read(a!.oid, bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(fake.requests).toEqual([]);
    await expect(reader.read(a!.oid, 0)).rejects.toBeInstanceOf(GitFetchError);
  });
});
