import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, Writable } from 'node:stream';
import { crc32, createDeflateRaw, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import {
  ArchiveError,
  MAX_ARCHIVE_INPUT_BYTES,
  buildZipFromTree,
  type ArchiveBlobSource,
  type ArchiveIo,
  type ArchiveStaging,
} from './archive.js';
import { ExportIgnore, exportIgnoreMatcher } from './export-ignore.js';
import type { GitTree, GitTreeEntry } from './fetch.js';

const enc = new TextEncoder();
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const PREFIX = '0123456789ab/';

const codecs: Pick<Codecs, 'digestTap' | 'deflateRaw'> = {
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
  deflateRaw: () =>
    Duplex.toWeb(createDeflateRaw()) as unknown as TransformStream<Uint8Array, Uint8Array>,
};

let dir: string;
let staging: ArchiveStaging;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pb-archive-'));
  let n = 0;
  staging = {
    create() {
      const file = path.join(dir, `zip-${n++}.tmp`);
      const stream = createWriteStream(file);
      return Promise.resolve({
        path: file,
        writable: Writable.toWeb(stream) as WritableStream<Uint8Array>,
        async discard() {
          if (!stream.closed)
            await new Promise<void>((resolve) => stream.once('close', () => resolve()));
          await rm(file, { force: true });
        },
      });
    },
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function gitOid(data: Uint8Array): string {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

function streamOf(data: Uint8Array, chunk = 4096): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(controller) {
      if (o >= data.length) controller.close();
      else {
        controller.enqueue(data.subarray(o, o + chunk));
        o += chunk;
      }
    },
  });
}

interface Fixture {
  readonly tree: GitTree;
  readonly io: ArchiveIo;
  readonly reads: { oid: string; maxBytes: number }[];
}

function treeOf(files: Record<string, string | Uint8Array>, extra: GitTreeEntry[] = []): Fixture {
  const blobs = new Map<string, Uint8Array>();
  const entries: GitTreeEntry[] = [];
  const dirs = new Set<string>();
  for (const [p, body] of Object.entries(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) {
        dirs.add(d);
        entries.push({ path: d, mode: '40000', type: 'tree', oid: 'd'.repeat(40) });
      }
    }
    const data = typeof body === 'string' ? enc.encode(body) : body;
    const oid = gitOid(data);
    blobs.set(oid, data);
    entries.push({ path: p, mode: '100644', type: 'blob', oid });
  }
  entries.push(...extra);
  const reads: { oid: string; maxBytes: number }[] = [];
  const source: ArchiveBlobSource = {
    read(oid, maxBytes) {
      reads.push({ oid, maxBytes });
      const data = blobs.get(oid);
      if (!data) return Promise.reject(new Error(`missing ${oid}`));
      return Promise.resolve({ size: data.length, body: streamOf(data) });
    },
  };
  return {
    tree: { commit: COMMIT, committedAt: '2024-01-01T00:00:00Z', entries, skipped: 0 },
    io: { staging, blobs: source },
    reads,
  };
}

function oidOfPath(f: Fixture, p: string): string {
  return (f.tree.entries.find((e) => e.path === p) as GitTreeEntry).oid;
}

function swapped(f: Fixture, victim: string, donor: string): Fixture {
  const victimOid = oidOfPath(f, victim);
  const donorOid = oidOfPath(f, donor);
  const io: ArchiveIo = {
    staging: f.io.staging,
    blobs: { read: (oid, max) => f.io.blobs.read(oid === victimOid ? donorOid : oid, max) },
  };
  return { ...f, io };
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly externalAttrs: number;
  readonly data: Uint8Array;
}

function readZip(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  expect(p + view.getUint32(eocd + 12, true)).toBe(eocd);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nlen = view.getUint16(p + 28, true);
    const xlen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const nameBytes = buf.subarray(p + 46, p + 46 + nlen);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint16(local + 6, true)).toBe(flags);
    const lnlen = view.getUint16(local + 26, true);
    expect(buf.subarray(local + 30, local + 30 + lnlen)).toEqual(nameBytes);
    const start = local + 30 + lnlen + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    expect(flags & 0x0008).toBe(0x0008);
    const desc = start + csize;
    expect(view.getUint32(desc, true)).toBe(0x08074b50);
    expect(view.getUint32(desc + 4, true)).toBe(crc);
    expect(view.getUint32(desc + 8, true)).toBe(csize);
    expect(view.getUint32(desc + 12, true)).toBe(usize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    expect(data.length).toBe(usize);
    out.push({
      name,
      flags,
      method,
      time: view.getUint16(p + 12, true),
      date: view.getUint16(p + 14, true),
      crc,
      externalAttrs: view.getUint32(p + 38, true),
      data,
    });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function build(f: Fixture, options?: { prefix?: string }) {
  const result = await buildZipFromTree(f.tree, codecs, f.io, options);
  const bytes = new Uint8Array(await readFile(result.path));
  return { result, bytes, entries: readZip(bytes) };
}

const strip = (names: string[]) =>
  names.map((n) => {
    expect(n.startsWith(PREFIX)).toBe(true);
    return n.slice(PREFIX.length);
  });

async function expectRefused(f: Fixture, code: string): Promise<void> {
  await expect(buildZipFromTree(f.tree, codecs, f.io)).rejects.toMatchObject({
    name: 'ArchiveError',
    code,
  });
  expect(await readdir(dir)).toEqual([]);
}

const SEMVER_GITATTRIBUTES = `# Auto-detect text files, ensure they use LF.
*       text=auto eol=lf

# These files are always considered text and should use LF.
# See core.whitespace @ http://git-scm.com/docs/git-config for whitespace flags.
*.php   text eol=lf whitespace=blank-at-eol,blank-at-eof,space-before-tab,tab-in-indent,tabwidth=4 diff=php
*.json  text eol=lf whitespace=blank-at-eol,blank-at-eof,space-before-tab,tab-in-indent,tabwidth=4

# Ignore these files in GitHub dists and \`git archive\` actions.
/.gitattributes export-ignore
/.github export-ignore
/.gitignore export-ignore
/.travis.yml export-ignore
/.php_cs export-ignore
/phpstan.neon.dist export-ignore
/phpunit.xml.dist export-ignore
/tests export-ignore
/CONTRIBUTING.md export-ignore
/phpstan-baseline.neon export-ignore
`;

const SEMVER_TREE = [
  '.github/dependabot.yml',
  '.github/workflows/continuous-integration.yml',
  '.github/workflows/lint.yml',
  '.github/workflows/phpstan.yml',
  '.github/workflows/vers.yml',
  '.github/workflows/zizmor.yml',
  '.gitignore',
  '.php_cs',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'composer.json',
  'phpstan-baseline.neon',
  'phpstan.neon.dist',
  'phpunit.xml.dist',
  'src/Comparator.php',
  'src/CompilingMatcher.php',
  'src/Constraint/Bound.php',
  'src/Constraint/Constraint.php',
  'src/Constraint/ConstraintInterface.php',
  'src/Constraint/MatchAllConstraint.php',
  'src/Constraint/MatchNoneConstraint.php',
  'src/Constraint/MultiConstraint.php',
  'src/Interval.php',
  'src/Intervals.php',
  'src/Semver.php',
  'src/VersionParser.php',
  'tests/ComparatorTest.php',
  'tests/CompilingMatcherTest.php',
  'tests/Constraint/ConstraintTest.php',
  'tests/Constraint/MatchAllConstraintTest.php',
  'tests/Constraint/MatchNoneConstraintTest.php',
  'tests/Constraint/MultiConstraintTest.php',
  'tests/IntervalsTest.php',
  'tests/SemverTest.php',
  'tests/SubsetsTest.php',
  'tests/VersionParserTest.php',
  'tests/vers/baseline.json',
  'tests/vers/run-vers-tests.php',
];

const CODELOAD_SEMVER_351 = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'composer.json',
  'src/Comparator.php',
  'src/CompilingMatcher.php',
  'src/Constraint/Bound.php',
  'src/Constraint/Constraint.php',
  'src/Constraint/ConstraintInterface.php',
  'src/Constraint/MatchAllConstraint.php',
  'src/Constraint/MatchNoneConstraint.php',
  'src/Constraint/MultiConstraint.php',
  'src/Interval.php',
  'src/Intervals.php',
  'src/Semver.php',
  'src/VersionParser.php',
];

describe('buildZipFromTree', () => {
  it('yields the codeload file names for the composer/semver 3.5.1 tree', async () => {
    const files: Record<string, string> = { '.gitattributes': SEMVER_GITATTRIBUTES };
    for (const p of SEMVER_TREE) files[p] = `contents of ${p}\n`.repeat(20);
    const { entries } = await build(treeOf(files));
    expect(strip(entries.map((e) => e.name))).toEqual(CODELOAD_SEMVER_351);
    for (const e of entries) {
      expect(new TextDecoder().decode(e.data)).toBe(
        `contents of ${e.name.slice(PREFIX.length)}\n`.repeat(20),
      );
    }
  });

  it('puts every entry under one top-level directory even when only src/ survives', async () => {
    const f = treeOf({
      '.gitattributes': '/.gitattributes export-ignore\n/tests export-ignore\n',
      'src/A.php': 'a',
      'src/B/C.php': 'c',
      'tests/T.php': 't',
    });
    const { entries } = await build(f);
    expect(entries.map((e) => e.name)).toEqual([`${PREFIX}src/A.php`, `${PREFIX}src/B/C.php`]);
    const custom = await build(f, { prefix: 'pkg-1.0/' });
    expect(custom.entries.map((e) => e.name)).toEqual(['pkg-1.0/src/A.php', 'pkg-1.0/src/B/C.php']);
  });

  it.each(['', 'a', '../', 'a/../', '/abs/', 'CON/', 'a\\b/'])(
    'refuses the prefix %j',
    async (prefix) => {
      const f = treeOf({ 'a.txt': 'a' });
      await expect(buildZipFromTree(f.tree, codecs, f.io, { prefix })).rejects.toMatchObject({
        code: 'bad_path',
      });
    },
  );

  it('sorts entries by path bytes', async () => {
    const f = treeOf({ 'c.txt': 'c', 'B.txt': 'B', 'a/z.txt': 'z', 'a.txt': 'a', 'é.txt': 'e' });
    const { entries } = await build(f);
    expect(strip(entries.map((e) => e.name))).toEqual([
      'B.txt',
      'a.txt',
      'a/z.txt',
      'c.txt',
      'é.txt',
    ]);
  });

  it('returns the path, size, sha1 and sha256 of the file it wrote', async () => {
    const { result, bytes } = await build(treeOf({ 'composer.json': '{"name":"a/b"}' }));
    expect(result.size).toBe(bytes.length);
    expect(result.sha1).toBe(createHash('sha1').update(bytes).digest('hex'));
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(path.dirname(result.path)).toBe(dir);
  });

  it('writes data descriptors, fixed timestamps, the UTF-8 flag, valid CRCs and unix modes', async () => {
    const f = treeOf({
      'bin/run': '#!/bin/sh\n',
      'src/zażółć.php': '',
      'big.txt': 'a'.repeat(5000),
    });
    Object.assign(f.tree.entries.find((e) => e.path === 'bin/run') as object, { mode: '100755' });
    const { entries } = await build(f);
    expect(strip(entries.map((e) => e.name))).toEqual(['big.txt', 'bin/run', 'src/zażółć.php']);
    for (const e of entries) {
      expect(e.flags).toBe(0x0808);
      expect(e.method).toBe(8);
      expect(e.time).toBe((8 << 11) | (15 << 5));
      expect(e.date).toBe((5 << 9) | (10 << 5) | 26);
      expect(e.crc).toBe(crc32(e.data));
    }
    expect(entries[1]?.externalAttrs).toBe((0o100755 << 16) >>> 0);
    expect(entries[2]?.data).toHaveLength(0);
    expect(entries[0]?.externalAttrs).toBe((0o100644 << 16) >>> 0);
  });

  it('is byte-identical for the same tree', async () => {
    const f = treeOf({ 'a.txt': 'x'.repeat(1000), 'b/c.txt': 'y' });
    const a = await buildZipFromTree(f.tree, codecs, f.io);
    const b = await buildZipFromTree(f.tree, codecs, f.io);
    expect(a.sha256).toBe(b.sha256);
  });

  it('skips symlinks and submodules', async () => {
    const f = treeOf({ 'a.txt': 'a' }, [
      { path: 'link', mode: '120000', type: 'blob', oid: 'e'.repeat(40) },
      { path: 'vendor', mode: '40000', type: 'tree', oid: 'd'.repeat(40) },
      { path: 'vendor/sub', mode: '160000', type: 'commit', oid: 'f'.repeat(40) },
    ]);
    const { entries } = await build(f);
    expect(strip(entries.map((e) => e.name))).toEqual(['a.txt']);
  });

  it.each([
    '../x',
    'a/../x',
    'a\\b',
    '/etc/passwd',
    'a\0b',
    `${'a'.repeat(1021)}.txt`,
    'a//b',
    './a',
    'a:b',
    'file.txt:stream',
    'CON',
    'CON .txt',
    'src/aux.txt',
    'com1',
    'COM\u00b9',
    'lpt\u00b3.txt',
    'LPT9.log',
    'nul.tar.gz',
    'CONIN$',
    'conout$.txt',
    'Clock$',
    '.git/config',
    'sub/.GIT/hooks',
    '.git./x',
    '.git /x',
    '.g\u200cit/config',
    '\ufeff.git/config',
    'git~1/config',
    'GI7EBA~1/config',
    'a\u0001b',
  ])('refuses the entry path %j and leaves no file behind', async (bad) => {
    const f = treeOf({ 'a.txt': 'a' });
    f.tree.entries.push({ path: bad, mode: '100644', type: 'blob', oid: oidOfPath(f, 'a.txt') });
    await expectRefused(f, 'bad_path');
  });

  it.each([
    ['README.md', 'readme.md'],
    ['a', 'a.'],
    ['a', 'a '],
    ['Src/x.php', 'src/y.php'],
    ['docs', 'DOCS/a.txt'],
  ])('refuses the case-fold or trailing dot collision %j / %j', async (a, b) => {
    await expectRefused(treeOf({ [a]: '1', [b]: '2' }), 'bad_path');
  });

  it('accepts names that only resemble reserved ones', async () => {
    const f = treeOf({
      'console.php': 'a',
      'a..b': 'b',
      com10: 'c',
      'gitx/a': 'd',
      'conin.txt': 'e',
    });
    const { entries } = await build(f);
    expect(strip(entries.map((e) => e.name))).toEqual([
      'a..b',
      'com10',
      'conin.txt',
      'console.php',
      'gitx/a',
    ]);
  });

  it('refuses a tree with skipped entries', async () => {
    const f = treeOf({ 'a.txt': 'a' });
    await expect(buildZipFromTree({ ...f.tree, skipped: 1 }, codecs, f.io)).rejects.toMatchObject({
      code: 'incomplete_tree',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses an unknown entry mode', async () => {
    const f = treeOf({ 'a.txt': 'a' });
    Object.assign(f.tree.entries[0] as object, { mode: '100664' });
    await expectRefused(f, 'bad_object');
  });

  it.each([
    ['100644', 'tree'],
    ['40000', 'blob'],
    ['160000', 'blob'],
    ['120000', 'commit'],
  ] as const)('refuses mode %s with type %s', async (mode, type) => {
    const f = treeOf({ 'a.txt': 'a' });
    f.tree.entries.push({ path: 'x', mode, type, oid: 'e'.repeat(40) });
    await expectRefused(f, 'bad_object');
  });

  it('refuses a blob whose bytes do not hash to its oid', async () => {
    await expectRefused(
      swapped(treeOf({ 'a.txt': 'a', 'b.txt': 'b' }), 'b.txt', 'a.txt'),
      'bad_object',
    );
  });

  it.each([
    ['longer', 1],
    ['shorter', -1],
  ] as const)('refuses a blob body %s than its declared size', async (_label, delta) => {
    const f = treeOf({ 'a.txt': 'abc' });
    const inner = f.io.blobs;
    const io: ArchiveIo = {
      staging,
      blobs: {
        async read(oid, maxBytes) {
          const r = await inner.read(oid, maxBytes);
          return { size: r.size - delta, body: r.body };
        },
      },
    };
    await expectRefused({ ...f, io }, 'bad_object');
  });

  it('passes the remaining budget to every read and counts header bytes', async () => {
    const f = treeOf({ 'a.txt': 'aaaa', 'b.txt': 'bb' });
    await build(f);
    const [first, second] = f.reads;
    expect(first?.maxBytes).toBeLessThan(MAX_ARCHIVE_INPUT_BYTES);
    const overhead = 30 + PREFIX.length + 5 + 16 + 46 + PREFIX.length + 5;
    expect((first?.maxBytes ?? 0) - (second?.maxBytes ?? 0)).toBe(4 + overhead);
  });

  it('refuses a blob larger than the remaining budget without reading it', async () => {
    let pulled = 0;
    let cancelled = false;
    const f = treeOf({ 'a.txt': 'a' });
    const io: ArchiveIo = {
      staging,
      blobs: {
        read: () =>
          Promise.resolve({
            size: MAX_ARCHIVE_INPUT_BYTES + 1,
            body: new ReadableStream<Uint8Array>({
              pull(c) {
                pulled++;
                c.enqueue(new Uint8Array(1));
              },
              cancel() {
                cancelled = true;
              },
            }),
          }),
      },
    };
    await expectRefused({ ...f, io }, 'too_large');
    expect(pulled).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });

  it('refuses input beyond the cap across entries and discards the partial file', async () => {
    const chunk = new Uint8Array(9 * 1024 * 1024);
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i * chunk.length <= MAX_ARCHIVE_INPUT_BYTES; i++) files[`f${i}`] = chunk;
    await expectRefused(treeOf(files), 'too_large');
  });

  it('wraps port failures in io_error and leaves no file behind', async () => {
    const f = treeOf({ 'a.txt': 'a', 'b.txt': 'b' });
    const failOid = oidOfPath(f, 'b.txt');
    const io: ArchiveIo = {
      staging,
      blobs: {
        read: (oid, max) =>
          oid === failOid ? Promise.reject(new Error('boom')) : f.io.blobs.read(oid, max),
      },
    };
    const error = await buildZipFromTree(f.tree, codecs, io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveError);
    expect(error).toMatchObject({ code: 'io_error', cause: new Error('boom') });
    expect(await readdir(dir)).toEqual([]);
  });

  it('wraps a staging failure and keeps the original error when discard fails', async () => {
    const f = treeOf({ 'a.txt': 'a' });
    const failing: ArchiveIo = {
      blobs: f.io.blobs,
      staging: { create: () => Promise.reject(new Error('disk')) },
    };
    await expect(buildZipFromTree(f.tree, codecs, failing)).rejects.toMatchObject({
      code: 'io_error',
    });
    const bad = swapped(treeOf({ 'a.txt': 'a', 'b.txt': 'b' }), 'b.txt', 'a.txt');
    const discardFails: ArchiveIo = {
      blobs: bad.io.blobs,
      staging: {
        async create() {
          const file = await staging.create();
          return { ...file, discard: () => Promise.reject(new Error('rm failed')) };
        },
      },
    };
    await expect(buildZipFromTree(bad.tree, codecs, discardFails)).rejects.toMatchObject({
      code: 'bad_object',
    });
  });

  it('leaves no staged file when the .gitattributes read fails', async () => {
    const f = treeOf({ '.gitattributes': '*.md export-ignore', 'a.txt': 'a' });
    const attrsOid = oidOfPath(f, '.gitattributes');
    const io: ArchiveIo = {
      staging,
      blobs: {
        read: (oid, max) =>
          oid === attrsOid ? Promise.reject(new Error('gone')) : f.io.blobs.read(oid, max),
      },
    };
    await expectRefused({ ...f, io }, 'io_error');
  });

  it('applies nested .gitattributes files, deepest last', async () => {
    const f = treeOf({
      '.gitattributes': '*.md export-ignore\n/build export-ignore\n',
      'README.md': 'r',
      'fixtures/c.json': 'c',
      'docs/.gitattributes': 'README.md -export-ignore\nfixtures export-ignore\n',
      'docs/README.md': 'd',
      'docs/NOTES.md': 'n',
      'docs/fixtures/a.json': 'a',
      'docs/x/fixtures/b.json': 'b',
      'build/.gitattributes': '* -export-ignore\n',
      'build/out.txt': 'o',
    });
    const { entries } = await build(f);
    expect(strip(entries.map((e) => e.name))).toEqual([
      '.gitattributes',
      'docs/.gitattributes',
      'docs/README.md',
      'fixtures/c.json',
    ]);
    expect(f.reads.map((r) => r.oid)).not.toContain(oidOfPath(f, 'build/.gitattributes'));
  });

  it.each([
    ['too many rules', Array.from({ length: 1001 }, (_, i) => `f${i} export-ignore`).join('\n')],
    ['a pattern too long', `${'a'.repeat(1025)} export-ignore`],
    ['too many wildcards', `${'*a'.repeat(33)} export-ignore`],
  ])('refuses .gitattributes with %s', async (_label, attrs) => {
    await expectRefused(treeOf({ '.gitattributes': attrs, 'a.txt': 'a' }), 'bad_attributes');
  });
});

describe('exportIgnoreMatcher', () => {
  it('matches anchored, basename, directory and double-star patterns', () => {
    const ignored = exportIgnoreMatcher(
      [
        '/tests/ export-ignore',
        '*.md export-ignore',
        'docs/**/draft export-ignore',
        '**/fixtures export-ignore',
        '/out/** export-ignore',
        'a**b export-ignore',
      ].join('\n'),
    );
    expect(ignored('tests/a.php')).toBe(true);
    expect(ignored('src/tests/a.php')).toBe(false);
    expect(ignored('tests')).toBe(false);
    expect(ignored('README.md')).toBe(true);
    expect(ignored('src/NOTES.md')).toBe(true);
    expect(ignored('docs/draft')).toBe(true);
    expect(ignored('docs/a/b/draft')).toBe(true);
    expect(ignored('src/x/fixtures/a.json')).toBe(true);
    expect(ignored('out/a/b')).toBe(true);
    expect(ignored('axxb')).toBe(true);
    expect(ignored('src/a.php')).toBe(false);
  });

  it('lets the last matching line win and honours unset and valued attributes', () => {
    const ignored = exportIgnoreMatcher(
      [
        '*.md export-ignore',
        'README.md -export-ignore',
        '# x export-ignore',
        '*.txt export-ignore',
        'keep.txt export-ignore=no',
        'a.log export-ignore',
        'a.log !export-ignore',
        '[attr]custom export-ignore',
      ].join('\n'),
    );
    expect(ignored('CHANGELOG.md')).toBe(true);
    expect(ignored('README.md')).toBe(false);
    expect(ignored('other.txt')).toBe(true);
    expect(ignored('keep.txt')).toBe(false);
    expect(ignored('a.log')).toBe(false);
    expect(ignored('#')).toBe(false);
  });

  it('unquotes quoted patterns', () => {
    const ignored = exportIgnoreMatcher(
      '"with space.txt" export-ignore\n"tab\\there" export-ignore\n"\\303\\251.txt" export-ignore\n"q\\"x" export-ignore',
    );
    expect(ignored('with space.txt')).toBe(true);
    expect(ignored('tab\there')).toBe(true);
    expect(ignored('é.txt')).toBe(true);
    expect(ignored('q"x')).toBe(true);
    expect(ignored('with')).toBe(false);
  });

  it('treats glob metacharacters and character classes like git', () => {
    const ignored = exportIgnoreMatcher(
      [
        '/file?.txt export-ignore',
        '/[ab].c export-ignore',
        '/a.b export-ignore',
        '/[[:digit:]]*.log export-ignore',
        '/x[!/]y export-ignore',
        '/n[^0-9]m export-ignore',
        '/[]]z export-ignore',
        '/bad[ export-ignore',
        '/esc\\*aped export-ignore',
      ].join('\n'),
    );
    expect(ignored('file1.txt')).toBe(true);
    expect(ignored('file/.txt')).toBe(false);
    expect(ignored('a.c')).toBe(true);
    expect(ignored('c.c')).toBe(false);
    expect(ignored('axb')).toBe(false);
    expect(ignored('7run.log')).toBe(true);
    expect(ignored('run.log')).toBe(false);
    expect(ignored('x/y')).toBe(false);
    expect(ignored('x-y')).toBe(true);
    expect(ignored('n5m')).toBe(false);
    expect(ignored('nqm')).toBe(true);
    expect(ignored(']z')).toBe(true);
    expect(ignored('bad[')).toBe(false);
    expect(ignored('esc*aped')).toBe(true);
    expect(ignored('escXaped')).toBe(false);
  });

  it('matches a pathological pattern in linear time', () => {
    const pattern = `${'*a'.repeat(10)}${'*?'.repeat(10)}*b`;
    const m = new ExportIgnore();
    m.add('', `${pattern} export-ignore`);
    const subject = 'a'.repeat(1024);
    const start = performance.now();
    expect(m.ignored(subject)).toBe(false);
    expect(m.ignored(`${'a'.repeat(1023)}b`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
