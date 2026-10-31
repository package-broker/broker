import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { fixtureStream, publishPathFlood } from '../../test-support/npm-publish-bounds.js';
import { createRequire } from 'node:module';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkTarball } from './tarball-walk.js';

import {
  entry,
  checksum,
  join,
  stream,
  manifest,
  pax,
  archive,
  walk,
} from '../../test-support/npm-publish.js';
const enc = new TextEncoder();

describe('publish tar walker', () => {
  it('captures identity, first readme and statistics across single-byte chunks', async () => {
    const result = await walkTarball(
      stream(
        archive(
          entry('package/package.json', manifest),
          entry('package/README.md', 'hello'),
          entry('package/readme.txt', 'later'),
        ),
        1,
      ),
      { name: 'test-package', version: '1.0.0' },
    );
    expect(result).toMatchObject({
      fileCount: 3,
      unpackedSize: enc.encode(manifest).length + 10,
      readme: 'hello',
      readmeTruncated: false,
    });
  });
  it.each(['1', '2', '3', '4', '6', '7', 'S', 'Z'])('refuses type %s', async (type) => {
    await expect(
      walk(archive(entry('package/package.json', manifest), entry('package/bad', '', type))),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it.each([
    '../outside',
    '/package/a',
    'C:/package/a',
    'package/../a',
    'package//a',
    'package/a/../b',
    'other/a',
  ])('refuses effective path %s', async (path) => {
    await expect(walk(archive(entry(path, manifest)))).rejects.toMatchObject({
      code: 'invalid_tarball',
    });
  });
  it.each(['x', 'g', 'L'])('validates overridden paths for %s', async (type) => {
    const value = type === 'L' ? '../outside\0' : pax('path', '../outside');
    await expect(
      walk(archive(entry('extension', value, type), entry('package/package.json', manifest))),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('honours pax path and decimal size over the header', async () => {
    const file = entry('unused', manifest);
    file.fill(48, 124, 135);
    checksum(file);
    const result = await walk(
      archive(
        entry(
          'extension',
          pax('path', 'package/package.json') + pax('size', String(enc.encode(manifest).length)),
          'x',
        ),
        file,
      ),
    );
    expect(result.fileCount).toBe(1);
  });
  it('honours GNU long names and base-256 size', async () => {
    const file = entry('unused', manifest);
    file.fill(0, 124, 136);
    file[124] = 128;
    file[135] = enc.encode(manifest).length;
    checksum(file);
    expect(
      (await walk(archive(entry('extension', 'package/package.json\0', 'L'), file))).fileCount,
    ).toBe(1);
  });
  it('accepts a directory trailing slash', async () => {
    expect(
      (await walk(archive(entry('package/', '', '5'), entry('package/package.json', manifest))))
        .fileCount,
    ).toBe(1);
  });
  it.each([
    'checksum',
    'octal',
    'padding',
    'terminator',
    'trailing',
    'duplicate',
    'missing',
    'mismatch',
    'truncated',
    'pax',
    'negative',
    'magic',
  ])('refuses %s', async (kind) => {
    let bytes = archive(entry('package/package.json', manifest));
    if (kind === 'checksum') bytes[0] = 0;
    if (kind === 'octal') {
      bytes[100] = 57;
      checksum(bytes);
    }
    if (kind === 'padding') bytes[512 + enc.encode(manifest).length] = 1;
    if (kind === 'terminator') bytes = bytes.subarray(0, bytes.length - 512);
    if (kind === 'trailing') bytes = join(bytes, Uint8Array.of(1));
    if (kind === 'duplicate')
      bytes = archive(
        entry('package/package.json', manifest),
        entry('package/package.json', manifest),
      );
    if (kind === 'missing') bytes = archive(entry('package/a'));
    if (kind === 'mismatch') bytes = archive(entry('package/package.json', '{}'));
    if (kind === 'truncated') bytes = bytes.subarray(0, 530);
    if (kind === 'pax')
      bytes = archive(
        entry('extension', '9 path=a\nBAD', 'x'),
        entry('package/package.json', manifest),
      );
    if (kind === 'negative') {
      bytes.fill(255, 124, 136);
      checksum(bytes);
    }
    if (kind === 'magic') {
      bytes[257] = 0;
      checksum(bytes);
    }
    await expect(walk(bytes)).rejects.toMatchObject({
      code: kind === 'missing' || kind === 'mismatch' ? 'manifest_mismatch' : 'invalid_tarball',
    });
  });
  it.each([
    { maxEntries: 0 },
    { maxUnpackedBytes: 1 },
    { maxPathBytes: 2 },
    { maxManifestBytes: 1 },
  ])('enforces limits %j', async (limits) => {
    await expect(
      walk(archive(entry('package/package.json', manifest)), limits),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('caps extension bodies', async () => {
    await expect(
      walk(archive(entry('extension', '12345', 'x')), { maxExtensionBytes: 4 }),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('truncates readme on a UTF-8 boundary', async () => {
    expect(
      await walk(archive(entry('package/package.json', manifest), entry('package/README', 'éé')), {
        maxReadmeBytes: 3,
      }),
    ).toMatchObject({ readme: 'é', readmeTruncated: true });
  });
});

describe('tar boundary cases', () => {
  it('accepts zero trailer padding of any length after two end blocks', async () => {
    expect(
      (await walk(join(archive(entry('package/package.json', manifest)), new Uint8Array(17))))
        .fileCount,
    ).toBe(1);
  });
  it('rejects an unsupported ustar version', async () => {
    const bytes = archive(entry('package/package.json', manifest));
    bytes[263] = 57;
    checksum(bytes);
    await expect(walk(bytes)).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('accepts a decimal pax size with leading zeros', async () => {
    expect(
      (
        await walk(
          archive(
            entry('extension', pax('size', '000' + new TextEncoder().encode(manifest).length), 'x'),
            entry('package/package.json', manifest),
          ),
        )
      ).fileCount,
    ).toBe(1);
  });
});

describe('adversarial archive fixtures', () => {
  it('accepts the generated positive control', async () => {
    const { readFile } = await import('node:fs/promises');
    const { gunzipSync } = await import('node:zlib');
    expect(
      (
        await walk(
          gunzipSync(
            await readFile(
              new URL('../../../../../fixtures/npm-publish/adversarial/good.tgz', import.meta.url),
            ),
          ),
        )
      ).fileCount,
    ).toBe(1);
  });
  it('refuses every stored archive', async () => {
    const { readFile } = await import('node:fs/promises');
    const { gunzipSync } = await import('node:zlib');
    const cases = JSON.parse(
      await readFile(
        new URL('../../../../../fixtures/npm-publish/adversarial/cases.json', import.meta.url),
        'utf8',
      ),
    ) as { id: string; code: string; options: Record<string, number>; reason: string }[];
    for (const item of cases) {
      const bytes = gunzipSync(
        await readFile(
          new URL(
            `../../../../../fixtures/npm-publish/adversarial/${item.id}.tgz`,
            import.meta.url,
          ),
        ),
      );
      await expect(walk(bytes, item.options), item.id).rejects.toMatchObject({
        code: item.code,
        detail: item.reason,
      });
    }
  });
});

describe('ancillary header numbers', () => {
  it('accepts base-256 identity fields and pre-epoch timestamps', async () => {
    const bytes = archive(entry('package/package.json', manifest));
    bytes.fill(0, 108, 116);
    bytes[108] = 128;
    bytes[112] = 1;
    bytes.fill(255, 136, 148);
    checksum(bytes);
    expect((await walk(bytes)).fileCount).toBe(1);
  });
  it('rejects ancillary numbers outside the safe integer range', async () => {
    const bytes = archive(entry('package/package.json', manifest));
    bytes.fill(255, 108, 116);
    bytes[108] = 128;
    checksum(bytes);
    await expect(walk(bytes)).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
});

describe('relative drive paths', () => {
  it.each(['package/C:/file', 'package/C:file'])('refuses %s', async (path) => {
    await expect(
      walk(archive(entry('package/package.json', manifest), entry(path))),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
});

describe('hard archive bounds', () => {
  it('does not allow callers to raise the extension cap', async () => {
    const large = pax('ignored', 'a'.repeat(65536));
    await expect(
      walk(archive(entry('extension', large, 'x'), entry('package/package.json', manifest)), {
        maxExtensionBytes: 100000,
      }),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('does not allow callers to raise the manifest cap', async () => {
    const large = JSON.stringify({
      name: 'test-package',
      version: '1.0.0',
      description: 'a'.repeat(262144),
    });
    await expect(
      walk(archive(entry('package/package.json', large)), { maxManifestBytes: 1000000 }),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('refuses a non-finite limit', async () => {
    await expect(
      walk(archive(entry('package/package.json', manifest)), { maxUnpackedBytes: NaN }),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
});

describe('global path interpretation', () => {
  it('does not let a global path hide an unsafe client-effective path', async () => {
    await expect(
      walk(
        archive(
          entry('extension', pax('path', 'package/package.json'), 'g'),
          entry('../outside', manifest),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('refuses global path overrides', async () => {
    await expect(
      walk(
        archive(
          entry('extension', pax('path', 'package/alias'), 'g'),
          entry('package/package.json', manifest),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it('refuses aliases that duplicate another entry under either interpretation', async () => {
    await expect(
      walk(
        archive(
          entry('extension', pax('path', 'package/alias'), 'g'),
          entry('package/package.json', manifest),
          entry('package/other', 'a'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
});

const npmPath = resolve(dirname(process.execPath), 'npm');
if (!existsSync(npmPath)) throw new Error(`Expected colocated npm at ${npmPath}`);
const npmRequire = createRequire(realpathSync(npmPath));
const tar = npmRequire('tar');
const tarVersion = (npmRequire('tar/package.json') as { version: string }).version;
if (tarVersion.split('.')[0] !== '7')
  throw new Error(`Expected node-tar major 7, got ${tarVersion}`);

describe(`tar interpretation against npm node-tar ${tarVersion}`, () => {
  async function clientPaths(bytes: Uint8Array) {
    const paths: string[] = [];
    const warnings: string[] = [];
    const parser = new tar.Parser({
      onReadEntry(e: { path: string; resume(): void }) {
        paths.push(e.path);
        e.resume();
      },
      onwarn(_code: string, message: string) {
        warnings.push(message);
      },
    });
    await new Promise<void>((ok, no) => {
      parser.on('end', ok);
      parser.on('error', no);
      parser.end(Buffer.from(bytes));
    });
    return { paths, warnings };
  }
  const metaEntryLimit = new tar.Parser().maxMetaEntrySize as number;
  it('reads the installed node-tar metadata limit', () => {
    expect(metaEntryLimit).toBe(1024 * 1024);
  });
  it('refuses the pax size chain whose GNU long name node-tar ignores', async () => {
    const size = metaEntryLimit + 1;
    const bytes = archive(
      entry('package/package.json', manifest),
      entry('extension', pax('path', '../escape') + pax('size', String(size)), 'x'),
      entry('extension', 'package/safe\0', 'L'),
      entry('package/file', 'a'.repeat(size)),
    );
    const client = await clientPaths(bytes);
    expect(client.paths).toEqual(['package/package.json', '../escape']);
    await expect(walk(bytes)).rejects.toMatchObject({
      code: 'invalid_tarball',
      status: 400,
      detail: 'pax_size_extension',
    });
  });
  it.each(['x', 'g', 'L', 'K'])(
    'refuses a zero pending pax size before %s like the divergent node-tar interpretation',
    async (type) => {
      const bytes = archive(
        entry('package/package.json', manifest),
        entry('extension', pax('size', '0'), 'x'),
        entry(
          'extension',
          type === 'L' ? 'package/safe\0' : type === 'K' ? '\0' : pax('comment', 'ok'),
          type,
        ),
        entry('package/empty'),
      );
      const client = await clientPaths(bytes);
      expect(client.paths).toEqual(['package/package.json', 'package/empty']);
      if (type === 'K') expect(client.warnings).toEqual([]);
      else expect(client.warnings.length).toBeGreaterThan(0);
      await expect(walk(bytes)).rejects.toMatchObject({
        code: 'invalid_tarball',
        status: 400,
        detail: 'pax_size_extension',
      });
    },
  );
  it.each(['x', 'g', 'L', 'K'])('refuses %s metadata beyond the node-tar limit', async (type) => {
    const bytes = archive(
      entry('package/package.json', manifest),
      entry('extension', 'a'.repeat(metaEntryLimit) + '\0', type),
      entry('package/safe'),
    );
    expect((await clientPaths(bytes)).paths).toEqual(['package/package.json', 'package/safe']);
    await expect(walk(bytes)).rejects.toMatchObject({
      code: 'invalid_tarball',
      status: 400,
      detail: 'extension_cap',
    });
  });
  it.each([100, 108, 116, 124, 136, 329, 337, 476, 488])(
    'refuses invalid base-256 marker at %s before a hidden symlink like node-tar',
    async (offset) => {
      const hidden = entry('package/hidden', '', '2');
      hidden[157] = 97;
      checksum(hidden);
      const carrier = join(entry('package/carrier', '', '0', 512).subarray(0, 512), hidden);
      carrier[offset] = 0x81;
      checksum(carrier);
      const bytes = archive(entry('package/package.json', manifest), carrier);
      const client = await clientPaths(bytes);
      expect(client.paths).toEqual(['package/package.json', 'package/hidden']);
      expect(client.warnings.length).toBeGreaterThan(0);
      await expect(walk(bytes)).rejects.toMatchObject({ code: 'invalid_tarball' });
    },
  );
  it.each(['path', 'comment'])(
    'refuses embedded pax newlines for %s before node-tar splits records',
    async (key) => {
      const bytes = archive(
        entry(
          'extension',
          pax(key, 'package/safe\n' + pax('path', 'package/evil.txt').trimEnd()),
          'x',
        ),
        entry('package/package.json', manifest),
      );
      const client = await clientPaths(bytes);
      expect(client.paths).toEqual(['package/evil.txt']);
      await expect(walk(bytes)).rejects.toMatchObject({
        code: 'invalid_tarball',
        detail: 'pax_record',
      });
    },
  );
  it.each(['x', 'g', 'L', 'K'])('refuses empty-name %s extensions like node-tar', async (type) => {
    const bytes = archive(
      entry(
        '',
        type === 'L' ? 'package/package.json\0' : type === 'K' ? '\0' : pax('comment', 'ok'),
        type,
      ),
      entry('package/package.json', manifest),
    );
    expect((await clientPaths(bytes)).warnings).toContain('path is required');
    await expect(walk(bytes)).rejects.toMatchObject({
      code: 'invalid_tarball',
      detail: 'header_path',
    });
  });
  it.each(['L', 'K'])('refuses forbidden linkname on %s extensions like node-tar', async (type) => {
    const ext = entry('extension', type === 'L' ? 'package/package.json\0' : '\0', type);
    ext[157] = 97;
    checksum(ext);
    const bytes = archive(ext, entry('package/package.json', manifest));
    expect((await clientPaths(bytes)).warnings).toContain('linkpath forbidden');
    await expect(walk(bytes)).rejects.toMatchObject({ detail: 'header_linkpath' });
  });
  it('preserves BOM in pax keys like node-tar', async () => {
    const bytes = archive(
      entry('extension', pax('\ufeffpath', '../outside'), 'x'),
      entry('package/package.json', manifest),
    );
    expect((await clientPaths(bytes)).paths).toEqual(['package/package.json']);
    expect((await walk(bytes)).manifest.name).toBe('test-package');
  });
  it('preserves BOM in tar paths like node-tar', async () => {
    const bytes = archive(entry('\ufeffpackage/package.json', manifest));
    expect((await clientPaths(bytes)).paths).toEqual(['\ufeffpackage/package.json']);
    await expect(walk(bytes)).rejects.toMatchObject({ code: 'invalid_tarball' });
  });
  it.each(['path', 'linkpath', 'size'])('refuses global %s even when empty', async (key) => {
    await expect(
      walk(archive(entry('extension', pax(key, ''), 'g'), entry('package/package.json', manifest))),
    ).rejects.toMatchObject({ detail: 'global_override' });
  });
  it('ignores benign global metadata', async () => {
    expect(
      (
        await walk(
          archive(
            entry('extension', pax('comment', 'ok'), 'g'),
            entry('package/package.json', manifest),
          ),
        )
      ).fileCount,
    ).toBe(1);
  });
  it('requires GNU version space-NUL', async () => {
    const bytes = archive(entry('package/package.json', manifest));
    bytes[262] = 32;
    checksum(bytes);
    await expect(walk(bytes)).rejects.toMatchObject({ detail: 'tar_version' });
    bytes[263] = 32;
    bytes[264] = 0;
    checksum(bytes);
    expect((await walk(bytes)).fileCount).toBe(1);
  });
  it.each([0, 32])('refuses blank size fields filled with %s', async (byte) => {
    const file = entry('package/empty');
    file.fill(byte, 124, 136);
    checksum(file);
    await expect(
      walk(archive(entry('package/package.json', manifest), file)),
    ).rejects.toMatchObject({ detail: 'blank_size' });
  });
  it('captures prototype-free archive objects recursively', async () => {
    const result = await walk(
      archive(
        entry(
          'package/package.json',
          JSON.stringify({
            name: 'test-package',
            version: '1.0.0',
            nested: { __proto__: null, value: 1 },
          }),
        ),
      ),
    );
    expect(Object.getPrototypeOf(result.manifest)).toBeNull();
    expect(Object.getPrototypeOf(result.manifest.nested)).toBeNull();
  });
});

it('bounds retained distinct UTF-8 paths before the archive entry and byte caps', async () => {
  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  const before = process.memoryUsage().heapUsed;
  let retained = Number.NaN;
  let samples = 0;
  const signals = {
    pulls: 0,
    bytes: 0,
    pull() {
      if (signals.pulls % 128 !== 0) return;
      gc();
      const delta = process.memoryUsage().heapUsed - before;
      retained = samples++ ? Math.max(retained, delta) : delta;
    },
  };
  await expect(
    walkTarball(fixtureStream(publishPathFlood(), signals), {
      name: 'test-package',
      version: '1.0.0',
    }),
  ).rejects.toMatchObject({ code: 'invalid_tarball', detail: 'path_bytes' });
  expect(signals.pulls).toBeLessThan(10000);
  expect(signals.bytes).toBeLessThan(256 * 1024 * 1024);
  expect(samples).toBeGreaterThan(10);
  expect(retained).toBeLessThan(32 * 1024 * 1024);
});

it('accepts exactly 16 MiB of retained path bytes', async () => {
  function* parts() {
    yield entry('package/package.json', manifest);
    let remaining = 16 * 1024 * 1024 - 'package/package.json'.length;
    for (let i = 0; remaining; i++) {
      const size = Math.min(4096, remaining);
      const path = ('package/' + String(i).padStart(5, '0')).padEnd(size, 'x');
      yield entry('extension', pax('path', path), 'x');
      yield entry('placeholder');
      remaining -= size;
    }
    yield new Uint8Array(1024);
  }
  await expect(
    walkTarball(fixtureStream(parts()), { name: 'test-package', version: '1.0.0' }),
  ).resolves.toMatchObject({ fileCount: 4097 });
});
