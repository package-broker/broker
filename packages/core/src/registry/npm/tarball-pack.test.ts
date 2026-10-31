import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync, createDeflateRaw } from 'node:zlib';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { archive, checksum, entry, pax, stream } from '../../test-support/npm-publish';
import { packTarball } from './tarball-pack';
import { PACKLIST_VERSION } from './packlist-rules';
import { walkRepositoryTarball, walkTarball } from './tarball-walk';

const npmPath = resolve(dirname(process.execPath), 'npm');
const npmRequire = createRequire(realpathSync(npmPath));
const tar = npmRequire('tar');
const codecs = { deflateRaw: () => Duplex.toWeb(createDeflateRaw()) };
const manifest = JSON.stringify({ name: 'fixture-package', version: '1.0.0' });
const root = resolve(import.meta.dirname, '../../../../../');
async function collect(body: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}
async function clientEntries(bytes: Uint8Array) {
  const entries: {
    path: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: Date;
    body: string;
  }[] = [];
  const parser = new tar.Parser({
    onReadEntry(e: {
      path: string;
      mode: number;
      uid: number;
      gid: number;
      mtime: Date;
      on: (event: string, cb: (data: Buffer) => void) => void;
    }) {
      let body = '';
      e.on('data', (chunk) => {
        body += chunk.toString();
      });
      e.on('end', () => {
        entries.push({ path: e.path, mode: e.mode, uid: e.uid, gid: e.gid, mtime: e.mtime, body });
      });
    },
  });
  await new Promise<void>((ok, no) => {
    parser.on('end', ok);
    parser.on('error', no);
    parser.end(gunzipSync(bytes));
  });
  return entries;
}
async function pack(bytes: Uint8Array, options = {}) {
  let opens = 0;
  const result = await packTarball({
    open: async () => {
      opens++;
      return stream(bytes, 17);
    },
    codecs,
    ...options,
  });
  const output = await collect(result.body);
  return { ...result, output, opens };
}

describe('two-pass repository pack', () => {
  it('pins the implemented packlist rules', () => {
    expect(PACKLIST_VERSION).toBe('10.0.4');
  });
  it('writes deterministic gzip, canonical ustar fields and executable modes in two passes', async () => {
    const executable = entry('repo/run', 'run');
    executable.set(new TextEncoder().encode('0000777\0'), 100);
    checksum(executable);
    const input = archive(
      entry('repo/package.json', manifest),
      executable,
      entry('repo/README', 'hello'),
    );
    const result = await pack(input);
    expect(result.opens).toBe(2);
    expect(result.output).toEqual((await pack(input)).output);
    expect(result.files).toEqual(['README', 'package.json', 'run']);
    expect(result.readme).toBe('hello');
    const entries = await clientEntries(result.output);
    expect(entries.map((e) => e.path)).toEqual([
      'package/package.json',
      'package/run',
      'package/README',
    ]);
    for (const e of entries) {
      expect(e.uid).toBe(0);
      expect(e.gid).toBe(0);
      expect(e.mtime.getTime()).toBe(0);
      expect(e.mode).toBe(e.path.endsWith('/run') ? 0o755 : 0o644);
    }
    await expect(
      walkTarball(stream(gunzipSync(result.output)), { name: 'fixture-package', version: '1.0.0' }),
    ).resolves.toMatchObject({ fileCount: 3, readme: 'hello' });
  });
  it('re-emits GNU and pax long paths as pax without changing content', async () => {
    const path = 'repo/' + 'é'.repeat(80) + '/file.js';
    const input = archive(
      entry('repo/package.json', manifest),
      entry('extension', path + '\0', 'L'),
      entry('placeholder', 'gnu'),
      entry('extension', pax('path', 'repo/' + 'x'.repeat(150)), 'x'),
      entry('placeholder2', 'pax'),
    );
    const result = await pack(input);
    const entries = await clientEntries(result.output);
    expect(entries.map((e) => [e.path, e.body])).toContainEqual([
      'package/' + path.slice(5),
      'gnu',
    ]);
    expect(entries.map((e) => [e.path, e.body])).toContainEqual([
      'package/' + 'x'.repeat(150),
      'pax',
    ]);
    expect(gunzipSync(result.output).includes(Buffer.from('path=package/'))).toBe(true);
  });
  it('skips symbolic links without following their targets', async () => {
    const link = entry('repo/link', '', '2');
    link.set(new TextEncoder().encode('../../outside'), 157);
    checksum(link);
    const result = await pack(archive(entry('repo/package.json', manifest), link));
    expect(result.files).toEqual(['package.json']);
  });
  it.each(['repo/../escape', '/repo/file', 'repo//file', 'repo/C:file', 'elsewhere/file', 'repo'])(
    'refuses unsafe or mixed-root path %s',
    async (path) => {
      await expect(
        pack(archive(entry('repo/package.json', manifest), entry(path))),
      ).rejects.toMatchObject({ code: 'invalid_tarball' });
    },
  );
  it('refuses duplicate paths', async () => {
    await expect(
      pack(archive(entry('repo/package.json', manifest), entry('repo/package.json', manifest))),
    ).rejects.toMatchObject({ detail: 'duplicate_path' });
  });
  it('refuses missing or invalid root manifests', async () => {
    await expect(pack(archive(entry('repo/a')))).rejects.toMatchObject({
      code: 'invalid_packlist',
    });
    await expect(pack(archive(entry('repo/package.json', '[]')))).rejects.toMatchObject({
      code: 'invalid_packlist',
    });
  });
  it.each([
    [{ maxEntries: 1 }, 'entry_cap'],
    [{ maxUnpackedBytes: 512 }, 'unpacked_cap'],
    [{ maxRuleBytes: 1 }, 'rule_cap'],
    [{ maxOutputBytes: 1 }, 'output_cap'],
  ] as const)('enforces cap %j', async (options, detail) => {
    await expect(
      pack(archive(entry('repo/package.json', manifest), entry('repo/a')), options),
    ).rejects.toMatchObject({ detail });
  });
  it('refuses a changed archive between passes', async () => {
    let opens = 0;
    const result = await packTarball({
      open: async () =>
        stream(
          archive(
            entry('repo/package.json', manifest),
            entry('repo/' + (++opens === 1 ? 'a' : 'b'), 'x'),
          ),
        ),
      codecs,
    });
    await expect(collect(result.body)).rejects.toMatchObject({ code: 'archive_changed' });
  });
  it('uses web stream deflate with the same tar bytes', async () => {
    const input = archive(entry('repo/package.json', manifest), entry('repo/a', 'data'));
    const web = await pack(input, {
      codecs: { deflateRaw: () => new CompressionStream('deflate-raw') },
    });
    expect(gunzipSync(web.output)).toEqual(gunzipSync((await pack(input)).output));
  });
  it('truncates only the first root readme on a UTF-8 boundary', async () => {
    const result = await pack(
      archive(
        entry('repo/package.json', manifest),
        entry('repo/README', 'é'.repeat(262145)),
        entry('repo/README.md', 'second'),
      ),
    );
    expect(result.readme?.length).toBe(262144);
    expect(new Set(result.readme)).toEqual(new Set(['é']));
    expect(result.readmeTruncated).toBe(true);
  });
  it.each([
    [entry('repo/package.json', 'x'.repeat(262145)), 'manifest_cap'],
    [entry('repo/README', 'bad\x01'), 'readme_control'],
    [
      (() => {
        const b = entry('repo/.npmignore', 'x');
        b[512] = 255;
        return b;
      })(),
      'utf8',
    ],
  ])('rejects malformed or oversized captured input %#', async (bad, detail) => {
    await expect(
      pack(
        archive(...(detail === 'manifest_cap' ? [] : [entry('repo/package.json', manifest)]), bad),
      ),
    ).rejects.toMatchObject({ detail });
  });
  it.each([NaN, -1, Infinity, 1.5])('rejects invalid limits %s', async (maxRuleBytes) => {
    await expect(
      pack(archive(entry('repo/package.json', manifest)), { maxRuleBytes }),
    ).rejects.toMatchObject({ detail: 'limit' });
  });
  it('does not cap or decode unconsumed ignores and unbundled manifests', async () => {
    const ignored = entry('repo/node_modules/unused/.npmignore', 'x');
    ignored[512] = 255;
    const result = await pack(
      archive(
        entry('repo/package.json', manifest),
        ignored,
        entry('repo/node_modules/unused/package.json', 'x'.repeat(262145)),
        entry('repo/node_modules/unused/.gitignore', '#'.repeat(4 * 1024 * 1024)),
        entry('repo/a.js', 'yes'),
      ),
    );
    expect(result.files).toEqual(['a.js', 'package.json']);
  });
  it('keeps captures below hard ceilings even when callers raise the limits', async () => {
    await expect(
      pack(
        archive(
          entry('repo/package.json', manifest),
          entry('repo/.npmignore', 'x'.repeat(4 * 1024 * 1024)),
        ),
        { maxRuleBytes: 10 * 1024 * 1024 },
      ),
    ).rejects.toMatchObject({ detail: 'packlist_budget' });
  });
  it('refuses symbolic links carrying a body', async () => {
    await expect(
      pack(archive(entry('repo/package.json', manifest), entry('repo/link', 'bad', '2'))),
    ).rejects.toMatchObject({ detail: 'symlink_size' });
  });
  it('refuses a second-pass archive ending early', async () => {
    let count = 0;
    const result = await packTarball({
      codecs,
      open: async () =>
        stream(
          archive(
            entry('repo/package.json', manifest),
            ...(count++ === 0 ? [entry('repo/a')] : []),
          ),
        ),
    });
    await expect(collect(result.body)).rejects.toMatchObject({ code: 'archive_changed' });
  });
  it('treats ordinary nested package manifests as file bytes', async () => {
    const result = await pack(
      archive(
        entry('repo/package.json', manifest),
        entry('repo/nested/package.json', 'x'.repeat(262145)),
      ),
    );
    expect(result.files).toEqual(['nested/package.json', 'package.json']);
  });
  it('refuses newlines in repository paths before writing pax', async () => {
    await expect(
      pack(
        archive(
          entry('repo/package.json', manifest),
          entry('extension', 'repo/' + 'x'.repeat(120) + '\nfile\0', 'L'),
          entry('placeholder'),
        ),
      ),
    ).rejects.toMatchObject({ detail: 'repository_path' });
  });
  it('propagates a failed reopen and compression failure', async () => {
    let count = 0;
    const result = await packTarball({
      codecs,
      open: async () => {
        if (count++) throw new Error('reopen_failed');
        return stream(archive(entry('repo/package.json', manifest)));
      },
    });
    await expect(collect(result.body)).rejects.toThrow('reopen_failed');
    await expect(
      pack(archive(entry('repo/package.json', manifest)), {
        codecs: {
          deflateRaw() {
            throw new Error('compression_failed');
          },
        },
      }),
    ).rejects.toThrow('compression_failed');
  });
  it('uses the readme selected into the produced tarball', async () => {
    const result = await pack(
      archive(
        entry(
          'repo/package.json',
          JSON.stringify({ name: 'fixture-package', version: '1.0.0', files: [] }),
        ),
        entry('repo/README~', 'excluded'),
        entry('repo/README.md', 'selected'),
      ),
    );
    const walked = await walkTarball(stream(gunzipSync(result.output)), {
      name: 'fixture-package',
      version: '1.0.0',
    });
    expect(result.readme).toBe('selected');
    expect(result.readme).toBe(walked.readme);
  });
  it('bounds captured readme candidates before selection', async () => {
    await expect(
      pack(
        archive(
          entry('repo/package.json', manifest),
          ...Array.from({ length: 33 }, (_, i) => entry('repo/README.' + i, 'x'.repeat(524288))),
        ),
      ),
    ).rejects.toMatchObject({ detail: 'packlist_budget' });
  });
  it('caps retained path bytes in pass one', async () => {
    const parts = Array.from({ length: 4200 }, (_, i) => {
      const path = 'repo/' + String(i).padStart(5, '0') + 'é'.repeat(2000);
      return [entry('extension', pax('path', path), 'x'), entry('placeholder')];
    }).flat();
    await expect(
      pack(archive(entry('repo/package.json', manifest), ...parts)),
    ).rejects.toMatchObject({ detail: 'packlist_budget' });
  });
  it('surfaces a repository abort reason instead of truncated', async () => {
    const abort = new AbortController();
    const reason = new Error('consumer_cancelled');
    let pulling = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulling = true;
      },
    });
    const result = walkRepositoryTarball(body, async () => {}, { signal: abort.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(pulling).toBe(true);
    abort.abort(reason);
    await expect(result).rejects.toBe(reason);
  });
  it('propagates output cancellation to the second input', async () => {
    let opens = 0,
      cancelled: unknown = false;
    const bytes = archive(
      entry('repo/package.json', manifest),
      entry('repo/a', 'x'.repeat(200000)),
    );
    const result = await packTarball({
      open: async () => {
        if (++opens === 1) return stream(bytes);
        const reader = stream(bytes, 512).getReader();
        return new ReadableStream({
          async pull(c) {
            const n = await reader.read();
            if (n.done) c.close();
            else c.enqueue(n.value);
          },
          async cancel(reason) {
            cancelled = reason;
            await reader.cancel(reason);
          },
        });
      },
      codecs,
    });
    const reader = result.body.getReader();
    await reader.read();
    const reason = new Error('consumer_cancelled');
    await reader.cancel(reason);
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled).toBe(reason);
  });
});

describe('differential repository fixtures against npm pack', () => {
  const fixtures = JSON.parse(
    readFileSync(resolve(root, 'fixtures/npm-repack/repositories.json'), 'utf8'),
  ) as {
    id: string;
    manifest: Record<string, unknown>;
    files: Record<string, string>;
    expected: string[];
    refusal?: string;
  }[];
  it.each(fixtures)('matches the recorded npm 11.17.0 file list: $id', async (fixture) => {
    const files = {
      ...fixture.files,
      'package.json': JSON.stringify({
        name: 'fixture-package',
        version: '1.0.0',
        ...fixture.manifest,
      }),
    };
    const pending = pack(
      archive(
        ...Object.entries(files)
          .reverse()
          .map(([path, body]) => entry('repo/' + path, body)),
      ),
    );
    if (fixture.refusal) {
      await expect(pending).rejects.toMatchObject({
        code: 'candidate_skipped',
        detail: fixture.refusal,
      });
      return;
    }
    const result = await pending;
    expect(result.files).toEqual(fixture.expected);
    expect((await clientEntries(result.output)).map((e) => e.path.slice(8)).sort()).toEqual(
      fixture.expected,
    );
  });
  const installed = (npmRequire('npm-packlist/package.json') as { version: string }).version;
  it('requires the live parity oracle when CI requests it', () => {
    if (process.env['PB_NPM_PARITY_REQUIRED'] === '1') {
      expect(installed, 'Required live npm pack differential must not be skipped').toBe(
        PACKLIST_VERSION,
      );
    }
  });
  const differential = installed === PACKLIST_VERSION ? it : it.skip;
  if (installed !== PACKLIST_VERSION)
    console.warn(
      `SKIP live npm pack: installed npm-packlist ${installed}; pinned ${PACKLIST_VERSION}`,
    );
  differential.each(fixtures)(
    'matches every fixture file list without running lifecycle scripts: $id',
    async (fixture) => {
      const scratch = await mkdtemp(resolve(root, 'node_modules/.npm-repack-'));
      try {
        const dir = resolve(scratch, fixture.id);
        await mkdir(dir);
        const files = {
          ...fixture.files,
          'package.json': JSON.stringify({
            name: 'fixture-package',
            version: '1.0.0',
            scripts: { prepack: 'exit 99', prepare: 'exit 99', postpack: 'exit 99' },
            ...fixture.manifest,
          }),
        };
        for (const [path, body] of Object.entries(files)) {
          await mkdir(dirname(resolve(dir, path)), { recursive: true });
          await writeFile(resolve(dir, path), body);
        }
        await symlink('missing-target', resolve(dir, 'symlink'));
        const client = JSON.parse(
          execFileSync(
            npmPath,
            [
              'pack',
              '--dry-run',
              '--json',
              '--ignore-scripts',
              '--offline',
              '--cache',
              resolve(scratch, 'cache'),
            ],
            { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        ) as { files: { path: string }[] }[];
        const bytes = archive(
          ...Object.entries(files)
            .reverse()
            .map(([path, body]) => entry('repo/' + path, body)),
        );
        expect(client[0]!.files.map((f) => f.path).sort(), fixture.id).toEqual(fixture.expected);
        if (fixture.refusal) {
          await expect(pack(bytes)).rejects.toMatchObject({
            code: 'candidate_skipped',
            detail: fixture.refusal,
          });
          return;
        }
        const result = await pack(bytes);
        expect(result.files, fixture.id).toEqual(fixture.expected);
        expect(
          (await clientEntries(result.output)).map((e) => e.path.slice(8)).sort(),
          fixture.id,
        ).toEqual(result.files);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    30000,
  );
});
