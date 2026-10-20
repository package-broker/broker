import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, BuildDiagnosticsError } from './build.js';
import { stageAssets, type PreparedAssets } from './build-assets.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const dirs: string[] = [];
const globals = globalThis as { __pbAssetCalls?: string[] };

afterEach(async () => {
  vi.restoreAllMocks();
  delete globals.__pbAssetCalls;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const HTML = '<!doctype html><script src="/app-abc123.js"></script>\n';
const SCRIPT = 'console.log("ui");\n';
const FILES: Record<string, string> = { 'index.html': HTML, 'app-abc123.js': SCRIPT };

function manifestFor(files: Record<string, string>): unknown {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
  return {
    version: 1,
    entry: 'index.html',
    files: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        { contentType: types[path.extname(name)], bytes: Buffer.byteLength(body) },
      ]),
    ),
  };
}

interface Options {
  files?: Record<string, string>;
  manifest?: unknown;
  providerSource?: (manifestUrl: string) => string;
  selection?: string | null;
  providerInstalled?: boolean;
  isolated?: boolean;
}

async function project(options: Options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pb-assets-'));
  dirs.push(root);
  const cwd = path.join(root, 'cwd');
  const configDir = path.join(root, 'config');
  const assetSource = path.join(root, 'asset-source');
  await mkdir(cwd);
  await mkdir(assetSource);
  await mkdir(path.join(configDir, 'node_modules'), { recursive: true });
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(cwd, 'node_modules'),
    'dir',
  );
  const files = options.files ?? FILES;
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(assetSource, name), body);
  }
  await writeFile(
    path.join(assetSource, 'manifest.json'),
    `${JSON.stringify(options.manifest ?? manifestFor(files), null, 2)}\n`,
  );
  const manifestUrl = pathToFileURL(path.join(assetSource, 'manifest.json')).href;
  const providerSource =
    options.providerSource ??
    ((url) => `export default {
  apiVersion: 1,
  async resolve(context) {
    (globalThis.__pbAssetCalls ??= []).push(context.target);
    return { manifestUrl: ${JSON.stringify(url)} };
  },
};
`);
  if (options.providerInstalled !== false) {
    const installed = options.isolated
      ? path.join(root, 'store', 'fake-assets')
      : path.join(configDir, 'node_modules', 'fake-assets');
    await mkdir(installed, { recursive: true });
    await writeFile(
      path.join(installed, 'package.json'),
      JSON.stringify({ name: 'fake-assets', version: '1.2.3', type: 'module', main: 'index.js' }),
    );
    await writeFile(path.join(installed, 'index.js'), providerSource(manifestUrl));
    if (options.isolated) {
      await symlink(installed, path.join(configDir, 'node_modules', 'fake-assets'), 'dir');
    }
  }
  await mkdir(path.join(configDir, 'node_modules', 'cfg-dep'), { recursive: true });
  await writeFile(
    path.join(configDir, 'node_modules', 'cfg-dep', 'package.json'),
    JSON.stringify({ name: 'cfg-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  await writeFile(
    path.join(configDir, 'node_modules', 'cfg-dep', 'index.js'),
    "export const platform = 'node';\n",
  );
  const selection = options.selection === undefined ? 'fake-assets' : options.selection;
  const assets =
    selection === null ? '' : `assets: [{ kind: 'ui', provider: ${JSON.stringify(selection)} }],`;
  const configPath = path.join(configDir, 'broker.config.ts');
  await writeFile(
    configPath,
    `import { platform } from 'cfg-dep';\nexport default { platform, plugins: [], ${assets} };\n`,
  );
  const runtimeEntry = path.join(cwd, 'entry.ts');
  await writeFile(runtimeEntry, "export { platformPorts } from '#pb-manifest';");
  return { root, cwd, configDir, assetSource, configPath, runtimeEntry };
}

type Project = Awaited<ReturnType<typeof project>>;

function run(
  p: Project,
  extra: { target?: 'node' | 'cloudflare'; outDir?: string; configPath?: string } = {},
) {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return build({
    cwd: p.cwd,
    runtimeEntry: p.runtimeEntry,
    ...extra,
    configPath: extra.configPath ?? p.configPath,
  });
}

async function failure(promise: Promise<unknown>): Promise<BuildDiagnosticsError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BuildDiagnosticsError);
  return error as BuildDiagnosticsError;
}

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

describe('asset staging', () => {
  it.each(['node', 'cloudflare'] as const)(
    'stages manifest and listed files byte-for-byte for %s from another cwd',
    async (target) => {
      const p = await project();
      const result = await run(p, { target });

      const assets = path.join(result.outDir, 'assets');
      expect((await readdir(assets)).sort()).toEqual([
        'app-abc123.js',
        'index.html',
        'manifest.json',
      ]);
      for (const name of ['manifest.json', ...Object.keys(FILES)]) {
        expect(await readFile(path.join(assets, name))).toEqual(
          await readFile(path.join(p.assetSource, name)),
        );
      }
      expect(globals.__pbAssetCalls).toEqual([target]);

      const record = JSON.parse(
        await readFile(path.join(result.outDir, 'assets.json'), 'utf8'),
      ) as {
        provider: { specifier: string; version: string };
        digest: string;
        descriptor: unknown;
      };
      expect(record.provider).toEqual({ specifier: 'fake-assets', version: '1.2.3' });
      expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.descriptor).toEqual({
        directory: './assets',
        binding: 'ASSETS',
        run_worker_first: true,
        html_handling: 'none',
        not_found_handling: 'none',
      });
      const pluginManifest = await readFile(result.manifestJson, 'utf8');
      expect(pluginManifest).not.toContain('ASSETS');
      expect(pluginManifest).not.toContain('fake-assets');
    },
  );

  it('keeps the digest stable for identical content and changes it with content', async () => {
    const first = await project();
    const second = await project();
    const changed = await project({ files: { ...FILES, 'app-abc123.js': 'console.log("v2");\n' } });
    const digest = async (p: Project) =>
      (
        JSON.parse(await readFile(path.join((await run(p)).outDir, 'assets.json'), 'utf8')) as {
          digest: string;
        }
      ).digest;

    expect(await digest(first)).toBe(await digest(second));
    expect(await digest(changed)).not.toBe(await digest(first));
  });

  it('honours a custom out directory and an isolated dependency layout', async () => {
    const p = await project({ isolated: true });
    const outDir = path.join(p.root, 'custom-out');

    const result = await run(p, { outDir });

    expect(result.outDir).toBe(outDir);
    expect(await readFile(path.join(outDir, 'assets', 'index.html'), 'utf8')).toBe(HTML);
  });

  it('replaces the asset directory as a set and removes it when nothing is selected', async () => {
    const p = await project();
    const first = await run(p);
    await writeFile(path.join(first.outDir, 'assets', 'stale-0000.js'), 'old');

    await run(p);
    expect((await readdir(path.join(first.outDir, 'assets'))).sort()).toEqual([
      'app-abc123.js',
      'index.html',
      'manifest.json',
    ]);

    const unselected = path.join(p.configDir, 'unselected.config.ts');
    await writeFile(
      unselected,
      "import { platform } from 'cfg-dep';\nexport default { platform, plugins: [] };\n",
    );
    await run(p, { configPath: unselected });
    expect(await exists(path.join(first.outDir, 'assets', 'manifest.json'))).toBe(false);
    expect(await exists(path.join(first.outDir, 'assets.json'))).toBe(false);
  });

  it('refuses to replace an asset directory the builder does not own', async () => {
    const p = await project();
    const outDir = path.join(p.cwd, '.pb', 'node');
    await mkdir(path.join(outDir, 'assets'), { recursive: true });
    await writeFile(path.join(outDir, 'assets', 'mine.txt'), 'keep');

    const error = await failure(run(p));

    expect(error.problems.join('\n')).toContain('not builder-owned');
    expect(await readFile(path.join(outDir, 'assets', 'mine.txt'), 'utf8')).toBe('keep');
  });

  it('fails when the selected provider cannot be resolved', async () => {
    const p = await project({ providerInstalled: false });

    const error = await failure(run(p));

    expect(error.problems.join('\n')).toContain('could not be resolved');
  });

  it('runs the provider only in the build pass and keeps Node-only imports out of the bundle', async () => {
    const p = await project({
      providerSource: (url) => `import { readFileSync } from 'node:fs';
import os from 'node:os';
export const marker = 'PROVIDER_ONLY_MARKER';
export default {
  apiVersion: 1,
  async resolve(context) {
    (globalThis.__pbAssetCalls ??= []).push(os.platform() && context.target);
    readFileSync(new URL(${JSON.stringify(url)}));
    return { manifestUrl: ${JSON.stringify(url)} };
  },
};
`,
    });

    const result = await run(p, { target: 'cloudflare' });

    expect(globals.__pbAssetCalls).toEqual(['cloudflare']);
    const worker = await readFile(result.bundle, 'utf8');
    expect(worker).not.toContain('node:os');
    expect(worker).not.toContain('node:fs');
    expect(worker).not.toContain('PROVIDER_ONLY_MARKER');
  });
});

describe('asset validation', () => {
  it('rejects a duplicate selection through the core config validator', async () => {
    const p = await project();
    await writeFile(
      p.configPath,
      "export default { platform: 'node', plugins: [], assets: [{ kind: 'ui', provider: 'a' }, { kind: 'ui', provider: 'b' }] };\n",
    );

    expect((await failure(run(p))).problems).toContain('assets: duplicate ui selection');
  });

  it('rejects a provider export that fails the core provider validator', async () => {
    const p = await project({
      providerSource: () => 'export default { apiVersion: 2, resolve() {} };\n',
    });

    expect((await failure(run(p))).problems).toContain('assets: unsupported provider apiVersion');
  });

  it('rejects a provider result that fails the core result validator', async () => {
    const p = await project({
      providerSource: () =>
        "export default { apiVersion: 1, resolve: async () => ({ manifestUrl: 'https://example.test/manifest.json' }) };\n",
    });

    expect((await failure(run(p))).problems).toContain(
      'assets: provider manifestUrl must be a local file URL',
    );
  });

  it('rejects a manifest that fails the schema', async () => {
    const p = await project({ manifest: { version: 2, entry: 'index.html', files: {} } });

    expect((await failure(run(p))).problems.join('\n')).toContain('version must be 1');
  });

  it('rejects an unsafe file name', async () => {
    const p = await project({
      manifest: {
        version: 1,
        entry: 'index.html',
        files: {
          'index.html': { contentType: 'text/html', bytes: 1 },
          '../evil.js': { contentType: 'text/javascript', bytes: 1 },
        },
      },
    });

    expect((await failure(run(p))).problems.join('\n')).toContain('file name is not allowed');
  });

  it('names a listed file that is missing', async () => {
    const p = await project();
    await rm(path.join(p.assetSource, 'app-abc123.js'));

    expect((await failure(run(p))).problems.join('\n')).toContain(
      'listed file "app-abc123.js" is missing',
    );
  });

  it('rejects a symlink that escapes the asset directory', async () => {
    const p = await project();
    const outside = path.join(p.root, 'outside.js');
    await writeFile(outside, SCRIPT);
    await rm(path.join(p.assetSource, 'app-abc123.js'));
    await symlink(outside, path.join(p.assetSource, 'app-abc123.js'));

    const problems = (await failure(run(p))).problems.join('\n');

    expect(problems).toContain('listed file "app-abc123.js" escapes the asset directory');
    expect(await exists(path.join(p.cwd, '.pb', 'node', 'assets', 'manifest.json'))).toBe(false);
  });

  it('rejects a listed entry that is not a regular file', async () => {
    const p = await project();
    await rm(path.join(p.assetSource, 'app-abc123.js'));
    await mkdir(path.join(p.assetSource, 'app-abc123.js'));

    expect((await failure(run(p))).problems.join('\n')).toContain(
      'listed file "app-abc123.js" is not a regular file',
    );
  });

  it('rejects a byte count that differs from the manifest', async () => {
    const p = await project();
    await writeFile(path.join(p.assetSource, 'app-abc123.js'), `${SCRIPT}tampered`);

    expect((await failure(run(p))).problems.join('\n')).toContain(
      `listed file "app-abc123.js" has ${Buffer.byteLength(SCRIPT) + 8} bytes`,
    );
  });

  it('does not copy files the manifest does not list', async () => {
    const p = await project();
    await writeFile(path.join(p.assetSource, 'unlisted.js'), 'x');

    const result = await run(p);

    expect(await readdir(path.join(result.outDir, 'assets'))).not.toContain('unlisted.js');
  });
});

describe('config location', () => {
  async function withPlugin(p: Project, installed: boolean): Promise<string> {
    if (installed) {
      const dir = path.join(p.configDir, 'node_modules', 'widgets-plugin');
      await mkdir(path.join(dir, 'migrations'), { recursive: true });
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'widgets-plugin', version: '4.5.6', type: 'module' }),
      );
      await writeFile(
        path.join(dir, 'migrations', '0001_init.sql'),
        'CREATE TABLE widgets_items (id TEXT PRIMARY KEY);\n',
      );
    }
    const configPath = path.join(p.configDir, 'plugin.config.ts');
    await writeFile(
      configPath,
      "export default { platform: 'node', plugins: [{ id: 'widgets', package: 'widgets-plugin', apiVersion: 3, platforms: ['node'], migrations: { dir: 'migrations' }, register: () => undefined }] };\n",
    );
    return configPath;
  }

  it('reads plugin versions and migrations from the config directory', async () => {
    const p = await project({ selection: null });
    const configPath = await withPlugin(p, true);

    const result = await run(p, { configPath });

    const info = JSON.parse(await readFile(result.buildInfo, 'utf8')) as {
      plugins: Record<string, string>;
    };
    expect(info.plugins).toEqual({ 'widgets-plugin': '4.5.6' });
    expect(
      await readFile(path.join(result.migrations, 'widgets', '0001_init.sql'), 'utf8'),
    ).toContain('widgets_items');
  });

  it('reports a plugin package that cannot be resolved as a build diagnostic', async () => {
    const p = await project({ selection: null });
    const configPath = await withPlugin(p, false);

    const error = await failure(run(p, { configPath }));

    expect(error.problems.join('\n')).toContain(
      'package "widgets-plugin" could not be resolved from the config location',
    );
  });

  it('builds from a read-only config directory and writes nothing next to the config', async () => {
    const p = await project();
    await chmod(p.configDir, 0o555);
    try {
      await run(p);
    } finally {
      await chmod(p.configDir, 0o755);
    }
    expect(await readdir(p.configDir)).not.toContain('.pb');
  });
});

describe('config location, shared sources and core', () => {
  it('resolves bare imports of a shared source from the importing file', async () => {
    const p = await project({ selection: null });
    const shared = path.join(p.root, 'shared');
    await mkdir(path.join(shared, 'node_modules', 'shared-dep'), { recursive: true });
    await writeFile(
      path.join(shared, 'node_modules', 'shared-dep', 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
    );
    await writeFile(
      path.join(shared, 'node_modules', 'shared-dep', 'index.js'),
      'export const ports = null;\n',
    );
    await writeFile(path.join(shared, 'x.ts'), "export { ports } from 'shared-dep';\n");
    const configPath = path.join(p.configDir, 'shared.config.ts');
    await writeFile(
      configPath,
      "import { platform } from 'cfg-dep';\nimport { ports } from '../shared/x.ts';\nexport default { platform, plugins: [], platformPorts: ports ?? undefined };\n",
    );

    await expect(run(p, { configPath })).resolves.toBeDefined();
  });

  it('records the core version the runtime bundles when the config dir cannot resolve core', async () => {
    const p = await project({ selection: null });
    expect(await readdir(path.join(p.configDir, 'node_modules'))).not.toContain('@package-broker');

    const result = await run(p);

    const info = JSON.parse(await readFile(result.buildInfo, 'utf8')) as { core: string };
    const core = JSON.parse(
      await readFile(new URL('../../core/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(info.core).toBe(core.version);
  });

  it('names the plugin whose package cannot be resolved', async () => {
    const p = await project({ selection: null });
    const configPath = path.join(p.configDir, 'missing.config.ts');
    await writeFile(
      configPath,
      "export default { platform: 'node', plugins: [{ id: 'widgets', package: 'absent-plugin', apiVersion: 3, platforms: ['node'], register: () => undefined }] };\n",
    );

    expect((await failure(run(p, { configPath }))).problems.join('\n')).toContain(
      'plugin "widgets": package "absent-plugin"',
    );
  });

  it('removes a first-build asset directory when the record cannot be put in place', async () => {
    const outDir = path.join(await mkdtemp(path.join(tmpdir(), 'pb-assets-stage-')));
    dirs.push(outDir);
    const prepared = {
      record: { schemaVersion: 1 },
      files: [{ name: 'manifest.json', content: Buffer.from('{}') }],
    } as unknown as PreparedAssets;
    const real = vi.mocked(rename).getMockImplementation();
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith('assets.json')) throw new Error('rename failed');
      return real?.(from, to);
    });

    await expect(stageAssets(outDir, prepared)).rejects.toThrow('rename failed');
    vi.mocked(rename).mockReset();

    expect(await readdir(outDir)).toEqual([]);
  });
});
