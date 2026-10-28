import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseUiManifest as coreParser } from '@package-broker/core/platform/ui-manifest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkBudget,
  checkLoadBudgets,
  measureInitialLoad,
  findInlineCode,
  parseUiManifest,
} from './manifest.js';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

beforeAll(async () => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  await run(process.execPath, [tsc, '-b', '../core'], {
    cwd: packageRoot,
    timeout: 60_000,
  });
}, 60_000);

const valid = {
  version: 1,
  entry: 'index.html',
  files: {
    'index.html': { contentType: 'text/html', bytes: 120 },
    'app.0123456789ab.js': { contentType: 'text/javascript', bytes: 4000 },
    'app.0123456789ab.css': { contentType: 'text/css', bytes: 900 },
  },
};

function withFile(name: string, contentType = 'text/css'): string {
  return JSON.stringify({ ...valid, files: { ...valid.files, [name]: { contentType, bytes: 1 } } });
}

describe('parseUiManifest', () => {
  it('uses the core parser directly and preserves the existing JSON format', () => {
    expect(parseUiManifest).toBe(coreParser);
    const text = `{
  "version": 1,
  "entry": "index.html",
  "files": {
    "index.html": {
      "contentType": "text/html",
      "bytes": 120
    },
    "app.0123456789ab.js": {
      "contentType": "text/javascript",
      "bytes": 4000
    },
    "app.0123456789ab.css": {
      "contentType": "text/css",
      "bytes": 900
    }
  }
}
`;
    expect(`${JSON.stringify(parseUiManifest(text), null, 2)}\n`).toBe(text);
  });
  it('accepts a well-formed manifest', () => {
    const manifest = parseUiManifest(JSON.stringify(valid));
    expect(manifest.entry).toBe('index.html');
    expect(manifest.files['app.0123456789ab.js']).toEqual({
      contentType: 'text/javascript',
      bytes: 4000,
    });
  });

  it('refuses a parent-directory file name', () => {
    expect(() => parseUiManifest(withFile('../x.js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a file name with a slash', () => {
    expect(() => parseUiManifest(withFile('a/b.js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a file name with a backslash', () => {
    expect(() => parseUiManifest(withFile('a\\b.js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a file name containing two dots', () => {
    expect(() => parseUiManifest(withFile('a..js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a leading-dot file name', () => {
    expect(() => parseUiManifest(withFile('.hidden'))).toThrow(/file name/);
  });

  it.each(['__proto__', 'a\0.js', 'a:b.js', 'a b.js', '%2e%2e%2f'])(
    'refuses unsafe file name %s',
    (name) => {
      expect(() => parseUiManifest(withFile(name))).toThrow(/file name/);
    },
  );

  it('returns a file dictionary with no prototype', () => {
    expect(Object.getPrototypeOf(parseUiManifest(JSON.stringify(valid)).files)).toBeNull();
  });

  it.each([
    ['x.js', 'text/html'],
    ['x.css', 'text/javascript'],
    ['x.html', 'text/css'],
  ])('refuses mismatched content type for %s', (name, contentType) => {
    expect(() => parseUiManifest(withFile(name, contentType))).toThrow(/content type/);
  });

  it('refuses a content type outside the allowlist', () => {
    expect(() => parseUiManifest(withFile('x.bin', 'application/octet-stream'))).toThrow(
      /content type/,
    );
  });

  it('refuses a non-object body', () => {
    expect(() => parseUiManifest('[]')).toThrow(/object/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseUiManifest('nope')).toThrow(/JSON/);
  });

  it('refuses an unknown version', () => {
    expect(() => parseUiManifest(JSON.stringify({ ...valid, version: 2 }))).toThrow(/version/);
  });

  it('refuses an entry that is not a listed file', () => {
    expect(() => parseUiManifest(JSON.stringify({ ...valid, entry: 'missing.html' }))).toThrow(
      /entry/,
    );
  });

  it('refuses a negative byte count', () => {
    const body = JSON.stringify({
      ...valid,
      files: { 'index.html': { contentType: 'text/html', bytes: -1 } },
    });
    expect(() => parseUiManifest(body)).toThrow(/bytes/);
  });
});

describe('browser bundle isolation', () => {
  it('keeps core modules out of the browser bundle inputs', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'pb-ui-isolation-test-'));
    try {
      const assets = path.join(scratch, 'assets');
      const metafile = path.join(scratch, 'metafile.json');
      await run(process.execPath, ['scripts/build.mjs', '--out', assets, '--metafile', metafile], {
        cwd: packageRoot,
        timeout: 60_000,
      });
      const { inputs, outputs } = JSON.parse(await readFile(metafile, 'utf8'));
      const entry = Object.keys(outputs).find((key) =>
        outputs[key].entryPoint?.endsWith('src/main.tsx'),
      )!;
      const initial = new Set<string>();
      const visit = (key: string) => {
        if (initial.has(key)) return;
        initial.add(key);
        for (const imported of outputs[key].imports) {
          if (imported.kind !== 'dynamic-import') visit(imported.path);
        }
      };
      visit(entry);
      for (const key of initial) {
        expect(outputs[key].entryPoint ?? '').not.toMatch(/src\/pages\//);
        expect(Object.keys(outputs[key].inputs).join('\n')).not.toMatch(/src\/pages\/[^/]+\.tsx/);
      }
      expect(
        outputs[entry].imports.filter((item: { kind: string }) => item.kind === 'dynamic-import'),
      ).toHaveLength(7);
      const inputPaths = Object.keys(inputs).map((input) =>
        path.resolve(packageRoot, input).split(path.sep).join('/'),
      );
      expect(inputPaths).toContain(
        path.join(packageRoot, 'src/main.tsx').split(path.sep).join('/'),
      );
      for (const input of inputPaths) {
        expect(input).not.toMatch(/(?:\/packages\/core\/|@package-broker\/core(?:\/|$))/);
      }
      expect((await readdir(assets)).some((name) => name.endsWith('.js'))).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('packed UI assets', () => {
  it('exports the manifest with every listed asset adjacent and preserves its bytes', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'pb-ui-pack-test-'));
    try {
      await run('pnpm', ['pack', '--pack-destination', scratch], {
        cwd: packageRoot,
        timeout: 60_000,
      });
      const originals = (await readdir(scratch)).filter((name) => name.endsWith('.tgz'));
      expect(originals).toHaveLength(1);
      await run('tar', ['-xzf', path.join(scratch, originals[0]!), '-C', scratch]);
      const stagedPackage = path.join(scratch, 'package');
      const assets = path.join(stagedPackage, 'dist/assets');
      await run(process.execPath, ['scripts/build.mjs', '--out', assets], {
        cwd: packageRoot,
        timeout: 60_000,
      });
      const packed = path.join(scratch, 'packed');
      await mkdir(packed);
      await run('pnpm', ['pack', '--pack-destination', packed], {
        cwd: stagedPackage,
        timeout: 60_000,
      });
      const tarballs = (await readdir(packed)).filter((name) => name.endsWith('.tgz'));
      expect(tarballs).toHaveLength(1);
      const tarball = path.join(packed, tarballs[0]!);
      const packedFile = async (name: string): Promise<Buffer> => {
        const { stdout } = await run('tar', ['-xOf', tarball, `package/${name}`], {
          encoding: 'buffer',
          maxBuffer: 10_000_000,
        });
        return stdout;
      };
      const pkg = JSON.parse((await packedFile('package.json')).toString('utf8'));
      const core = JSON.parse(
        await readFile(new URL('../../core/package.json', import.meta.url), 'utf8'),
      );
      expect(pkg.name).toBe('@package-broker/ui');
      expect(pkg.exports['./assets/manifest.json']).toBe('./dist/assets/manifest.json');
      expect(pkg.peerDependencies['@package-broker/core']).toBe(`^${core.version}`);
      const manifestBytes = await packedFile('dist/assets/manifest.json');
      expect(manifestBytes.equals(await readFile(path.join(assets, 'manifest.json')))).toBe(true);
      const manifest = parseUiManifest(manifestBytes.toString('utf8'));
      for (const [name, descriptor] of Object.entries(manifest.files)) {
        const bytes = await packedFile(`dist/assets/${name}`);
        expect(bytes.length).toBe(descriptor.bytes);
        if (name.endsWith('.js')) {
          expect(name).toContain(
            `.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.`,
          );
          for (const [, dependency] of bytes
            .toString('utf8')
            .matchAll(/(?:from|import)\s*(?:\(\s*)?["']\.\/([^"']+)["']/g)) {
            expect(Object.hasOwn(manifest.files, dependency!)).toBe(true);
          }
        }
        expect(bytes.equals(await readFile(path.join(assets, name)))).toBe(true);
      }
      const names = Object.keys(manifest.files);
      expect(names).toEqual(expect.arrayContaining(['index.html', 'setup.html']));
      const scripts = names.filter((name) => name.endsWith('.js'));
      expect(scripts.length).toBeGreaterThan(9);
      for (const name of scripts) expect(name).toMatch(/^[a-z-]+\.[a-f0-9]{12}\.js$/);
      for (const page of [
        'projects',
        'access',
        'sources',
        'packages',
        'tokens',
        'audit',
        'import',
      ]) {
        expect(scripts.some((name) => name.startsWith(`${page}.`))).toBe(true);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('findInlineCode', () => {
  const page = (body: string): string =>
    `<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body>${body}</body></html>`;

  it('accepts a page that only links files', () => {
    expect(
      findInlineCode(page('<div id="root"></div><script type="module" src="app.js"></script>')),
    ).toEqual([]);
  });

  it('flags an inline script', () => {
    expect(findInlineCode(page('<script>alert(1)</script>'))).toEqual(['inline script']);
  });

  it('flags an inline script injected beside a linked one', () => {
    const html = page('<script src="app.js"></script><script type="module">boot()</script>');
    expect(findInlineCode(html)).toEqual(['inline script']);
  });

  it('flags an inline script with data-src', () => {
    expect(findInlineCode(page('<script data-src="app.js">boot()</script>'))).toEqual([
      'inline script',
    ]);
  });

  it('flags an event handler attribute', () => {
    expect(findInlineCode(page('<button onclick="boot()">Go</button>'))).toEqual([
      'event handler attribute',
    ]);
  });

  it('flags a javascript URL', () => {
    expect(findInlineCode(page('<a href="javascript:boot()">Go</a>'))).toEqual(['javascript URL']);
  });

  it('flags a style element', () => {
    expect(findInlineCode(page('<style>a{color:red}</style>'))).toEqual(['style element']);
  });

  it('flags a style attribute', () => {
    expect(findInlineCode(page('<p style="color:red">x</p>'))).toEqual(['style attribute']);
  });
});

describe('checkBudget', () => {
  it('passes at the budget', () => {
    expect(checkBudget(1000, 1000)).toEqual({ ok: true, limit: 1100 });
  });

  it('passes at exactly +10%', () => {
    expect(checkBudget(1100, 1000).ok).toBe(true);
  });

  it('fails above +10%', () => {
    expect(checkBudget(1101, 1000)).toEqual({ ok: false, limit: 1100 });
  });
});

describe('split load budgets', () => {
  it('counts static dependencies once and excludes dynamic pages from initial load', () => {
    const outputs = {
      app: {
        imports: [
          { path: 'shared', kind: 'import-statement' },
          { path: 'page', kind: 'dynamic-import' },
        ],
      },
      shared: { imports: [{ path: 'common', kind: 'import-statement' }] },
      common: { imports: [] },
      page: { imports: [{ path: 'common', kind: 'import-statement' }] },
    };
    expect(
      measureInitialLoad(outputs, 'app', { app: 100, shared: 200, common: 50, page: 400 }, 25),
    ).toEqual({ initialGzipBytes: 375, chunkGzipBytes: 400 });
  });

  it('enforces both independent caps and falls back to the unchanged legacy baseline', () => {
    const budget = { gzipBytes: 1000, initialGzipBytes: 500, chunkGzipBytes: 100 };
    expect(checkLoadBudgets({ initialGzipBytes: 550, chunkGzipBytes: 110 }, budget)).toEqual({
      initial: { ok: true, limit: 550 },
      chunk: { ok: true, limit: 110 },
    });
    expect(checkLoadBudgets({ initialGzipBytes: 551, chunkGzipBytes: 111 }, budget)).toEqual({
      initial: { ok: false, limit: 550 },
      chunk: { ok: false, limit: 110 },
    });
    expect(
      checkLoadBudgets({ initialGzipBytes: 1100, chunkGzipBytes: 1101 }, { gzipBytes: 1000 }).chunk
        .ok,
    ).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid budgets: %s', (value) => {
    expect(() =>
      checkLoadBudgets(
        { initialGzipBytes: 1, chunkGzipBytes: 1 },
        { initialGzipBytes: value, chunkGzipBytes: 100 },
      ),
    ).toThrow(/positive safe integers/);
  });
});
