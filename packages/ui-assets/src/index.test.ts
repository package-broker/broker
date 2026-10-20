import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetProviderProblems, assetProviderResultProblems } from '@package-broker/core/config';
import type { AssetProviderV1 } from '@package-broker/core/config';
import provider, { createUiAssetsProvider } from './index.js';

function manifestOf(name: string): string {
  return JSON.stringify({ version: 1, entry: 'index.html', files: {}, marker: name });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe('ui-assets provider', () => {
  let root: string;
  let previousCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pb-ui-assets-'));
    previousCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  function installUi(base: string, name: string): string {
    const ui = join(base, 'node_modules', '@package-broker', 'ui');
    writeJson(join(ui, 'package.json'), {
      name: '@package-broker/ui',
      version: '1.0.0',
      type: 'module',
      exports: { './assets/manifest.json': './dist/assets/manifest.json' },
    });
    mkdirSync(join(ui, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(ui, 'dist', 'assets', 'manifest.json'), manifestOf(name));
    return join(ui, 'dist', 'assets', 'manifest.json');
  }

  function anchorIn(base: string): URL {
    const dir = join(base, 'node_modules', '@package-broker', 'ui-assets', 'dist');
    mkdirSync(dir, { recursive: true });
    return pathToFileURL(join(dir, 'index.js'));
  }

  it('is a valid versioned provider', () => {
    expect(provider.apiVersion).toBe(1);
    expect(assetProviderProblems(provider)).toEqual([]);
  });

  it('returns the file URL of the UI manifest export for every target', async () => {
    const manifest = installUi(root, 'a');
    const bridge = createUiAssetsProvider(anchorIn(root));
    for (const target of ['node', 'cloudflare'] as const) {
      const result = await bridge.resolve({ target });
      expect(assetProviderResultProblems(result)).toEqual([]);
      expect(realpathSync(fileURLToPath(result.manifestUrl))).toBe(realpathSync(manifest));
      expect(readFileSync(new URL(result.manifestUrl), 'utf8')).toBe(manifestOf('a'));
    }
  });

  it('resolves from the bridge location, not from the working directory', async () => {
    const bridgeBase = join(root, 'bridge');
    const otherBase = join(root, 'other');
    installUi(bridgeBase, 'bridge');
    installUi(otherBase, 'other');
    process.chdir(otherBase);
    const result = await createUiAssetsProvider(anchorIn(bridgeBase)).resolve({ target: 'node' });
    expect(readFileSync(new URL(result.manifestUrl), 'utf8')).toBe(manifestOf('bridge'));
  });

  it('accepts a file path anchor', async () => {
    installUi(root, 'path');
    const anchor = fileURLToPath(anchorIn(root));
    const result = await createUiAssetsProvider(anchor).resolve({ target: 'cloudflare' });
    expect(readFileSync(new URL(result.manifestUrl), 'utf8')).toBe(manifestOf('path'));
  });

  it('resolves the default export from its own location, independent of the working directory', async () => {
    const bridgeBase = join(root, 'bridge');
    const otherBase = join(root, 'other');
    installUi(bridgeBase, 'bridge');
    installUi(otherBase, 'other');
    const installed = fileURLToPath(anchorIn(bridgeBase));
    writeFileSync(
      installed,
      stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8')),
    );
    process.chdir(otherBase);

    const loaded = (await import(pathToFileURL(installed).href)) as { default: AssetProviderV1 };
    const result = await loaded.default.resolve({ target: 'node' });

    expect(readFileSync(new URL(result.manifestUrl), 'utf8')).toBe(manifestOf('bridge'));
  });

  it('rejects when the manifest export is declared but its file is missing', async () => {
    const manifest = installUi(root, 'gone');
    rmSync(manifest);
    const bridge = createUiAssetsProvider(anchorIn(root));
    await expect(bridge.resolve({ target: 'node' })).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
    });
  });

  it('rejects when the installed UI package does not export the manifest', async () => {
    const ui = join(root, 'node_modules', '@package-broker', 'ui');
    writeJson(join(ui, 'package.json'), {
      name: '@package-broker/ui',
      version: '1.0.0',
      exports: { '.': './index.js' },
    });
    const bridge = createUiAssetsProvider(anchorIn(root));
    await expect(bridge.resolve({ target: 'node' })).rejects.toThrow(/assets\/manifest\.json/);
  });
});

describe('ui-assets manifest', () => {
  interface PackageJson {
    private?: boolean;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }
  const read = (path: string) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as PackageJson;
  const pkg = read('../package.json');
  const ui = read('../../ui/package.json');
  const core = read('../../core/package.json');
  const FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

  it('depends on UI in production and on core as a peer plus development dependency', () => {
    expect(pkg.dependencies).toEqual({ '@package-broker/ui': 'workspace:^' });
    expect(pkg.peerDependencies).toEqual({ '@package-broker/core': 'workspace:^' });
    expect(pkg.devDependencies).toEqual({ '@package-broker/core': 'workspace:^' });
    expect(pkg.private).toBeUndefined();
  });

  it('only resolves a manifest export that UI publishes', () => {
    expect(ui.exports?.['./assets/manifest.json']).toBeTypeOf('string');
    expect(core.exports?.['./config']).toBeDefined();
  });

  it('is not a dependency of the CLI, runtimes, core or UI', () => {
    for (const name of ['cli', 'core', 'ui', 'runtime-node', 'runtime-cloudflare', 'db-sqlite']) {
      const other = read(`../../${name}/package.json`);
      for (const field of FIELDS) {
        expect(Object.keys(other[field] ?? {})).not.toContain('@package-broker/ui-assets');
      }
    }
    for (const name of ['cli', 'runtime-node', 'runtime-cloudflare', 'db-sqlite']) {
      const other = read(`../../${name}/package.json`);
      for (const field of FIELDS) {
        expect(Object.keys(other[field] ?? {})).not.toContain('@package-broker/ui');
      }
    }
  });
});
