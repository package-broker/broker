import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, BuildDiagnosticsError } from './build.js';
import { run } from './cli.js';
import { toManifestMigrations } from './build-artifacts.js';
import { BuiltManifestError, loadBuiltMigrations } from './commands/built-manifest.js';
import { diagnoseRoutes, renderManifestJson, type Manifest } from './manifest.js';

vi.mock('./manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./manifest.js')>();
  return { ...actual, diagnoseRoutes: vi.fn(actual.diagnoseRoutes) };
});

const CORE_SQL = 'CREATE TABLE core_items (id TEXT PRIMARY KEY);\n';
const PLUGIN_SQL = 'CREATE TABLE github_repos (id TEXT PRIMARY KEY);\n';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<MigrationSource[]> {
  return [
    await loadMigrationSource('core', '0001_init.sql', CORE_SQL),
    await loadMigrationSource('github', '0001_a.sql', PLUGIN_SQL),
  ];
}

async function writeBuild(outDir: string, sources: readonly MigrationSource[]): Promise<void> {
  await mkdir(path.join(outDir, 'generated'), { recursive: true });
  for (const source of sources) {
    const ownerDir = path.join(outDir, 'migrations', source.owner);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(path.join(ownerDir, `${source.name}.sql`), source.sql);
  }
  const manifest = renderManifestJson([], new Map(), 'node', {
    migrations: toManifestMigrations(sources),
  });
  await writeFile(
    path.join(outDir, 'generated', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

describe('build manifest round trip', () => {
  it('loads the migrations the build wrote, in plan order with matching checksums', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'pb-roundtrip-'));
    dirs.push(outDir);
    const sources = await fixture();

    await writeBuild(outDir, sources);

    const loaded = await loadBuiltMigrations(outDir);

    expect(loaded.map((source) => source.id)).toEqual(['core:0001_init', 'github:0001_a']);
    expect(loaded.map((source) => source.name)).toEqual(['0001_init', '0001_a']);
    expect(loaded.map((source) => source.checksum)).toEqual(
      sources.map((source) => source.checksum),
    );
    expect(loaded.map((source) => source.phase)).toEqual(['expand', 'expand']);
  });

  it('names the manifest entries as the files written under migrations/<owner>/', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'pb-roundtrip-'));
    dirs.push(outDir);

    await writeBuild(outDir, await fixture());

    const manifest = JSON.parse(
      await readFile(path.join(outDir, 'generated', 'manifest.json'), 'utf8'),
    ) as Manifest;
    expect(manifest.migrations.map((migration) => migration.name)).toEqual([
      '0001_init.sql',
      '0001_a.sql',
    ]);
    for (const [owner, name] of [
      ['core', '0001_init.sql'],
      ['github', '0001_a.sql'],
    ] as const) {
      expect(await readFile(path.join(outDir, 'migrations', owner, name), 'utf8')).not.toBe('');
    }
  });

  it('rejects a manifest that carries the collected file stem instead of the file name', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'pb-roundtrip-'));
    dirs.push(outDir);
    const sources = await fixture();

    await mkdir(path.join(outDir, 'generated'), { recursive: true });
    await mkdir(path.join(outDir, 'migrations', 'core'), { recursive: true });
    await writeFile(path.join(outDir, 'migrations', 'core', '0001_init.sql'), CORE_SQL);
    const manifest = renderManifestJson([], new Map(), 'node', { migrations: sources });
    await writeFile(
      path.join(outDir, 'generated', 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await expect(loadBuiltMigrations(outDir)).rejects.toBeInstanceOf(BuiltManifestError);
  });
});

const NODE_PORTS = {
  blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
  cache: { adapter: 'lru', maxBytes: 1024 },
  jobs: { adapter: 'database', maxRunning: 2 },
  observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

async function buildFixture(platformPorts: unknown, jobs = false) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pb-port-warning-'));
  dirs.push(cwd);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(cwd, 'node_modules'),
    'dir',
  );
  const configPath = path.join(cwd, 'broker.config.ts');
  const runtimeEntry = path.join(cwd, 'runtime.ts');
  const plugins = jobs
    ? `[{ id: 'jobby', package: '@test/jobby', apiVersion: 3, platforms: ['node'], register: (r) => r.job({ name: 'tick', version: 1, validate: (x) => x, handler: async () => {} }) }]`
    : '[]';
  await writeFile(
    configPath,
    `export default { platform: 'node', plugins: ${plugins}, platformPorts: ${JSON.stringify(platformPorts)} };`,
  );
  await writeFile(runtimeEntry, "export { platformPorts } from '#pb-manifest';");
  return { cwd, configPath, runtimeEntry };
}

describe('build platform ports warning', () => {
  it.each(['node', 'cloudflare'] as const)(
    'warns exactly once when %s has no stanza',
    async (target) => {
      const options = await buildFixture(undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await build({ ...options, target });
      expect(warn.mock.calls).toEqual([
        [
          `warning: no platformPorts stanza for ${target}; blob, cache, jobs and observability ports are disabled`,
        ],
      ]);
      const manifest = JSON.parse(await readFile(result.manifestJson, 'utf8')) as Manifest;
      expect(manifest.platformPorts).toBeNull();
    },
  );

  it('warns when only the other target has a stanza', async () => {
    const options = await buildFixture({ node: NODE_PORTS });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await build({ ...options, target: 'cloudflare' });
    expect(warn.mock.calls).toEqual([
      [
        'warning: no platformPorts stanza for cloudflare; blob, cache, jobs and observability ports are disabled',
      ],
    ]);
  });

  it('does not warn when the target has a stanza', async () => {
    const options = await buildFixture({ node: NODE_PORTS });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await build(options);
    expect(warn).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(result.manifestJson, 'utf8')) as Manifest;
    expect(manifest.platformPorts).toEqual(NODE_PORTS);
  });

  it('rejects registered jobs without a stanza before warning', async () => {
    const options = await buildFixture(undefined, true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(build(options)).rejects.toThrow(
      'jobs: registered but platformPorts.node is not configured',
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

async function routeFixture(permission: string | null) {
  const options = await buildFixture({ node: NODE_PORTS });
  await writeFile(
    options.configPath,
    `export default { platform: 'node', plugins: [{ id: 'widgets', package: '@test/widgets', apiVersion: 3, platforms: ['node'], register: (r) => r.route({ method: 'GET', path: '/widgets', permission: ${JSON.stringify(permission)}, boundary: 'organization', handler: () => new Response(null) }) }], platformPorts: { node: ${JSON.stringify(NODE_PORTS)} } };`,
  );
  return options;
}

describe('build catalogue diagnostics', () => {
  it('fails with the problem listed and writes no manifest when a route names an unknown permission', async () => {
    const options = await routeFixture('org:typo');
    const failure = await build(options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BuildDiagnosticsError);
    const problems = (failure as BuildDiagnosticsError).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.includes('org:typo'))).toBe(true);
    await expect(
      readFile(path.join(options.cwd, '.pb', 'node', 'generated', 'manifest.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a non-diagnostic failure as a plain error', async () => {
    const options = await buildFixture(undefined, true);
    const failure = await build(options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BuildDiagnosticsError);
  });
});

describe('pb build exit codes', () => {
  it('exits 2 and prints one error line per problem for a diagnostics failure', async () => {
    const options = await routeFixture('org:typo');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(options.cwd);
    try {
      expect(await run(['build', '--config', options.configPath])).toBe(2);
    } finally {
      cwd.mockRestore();
    }
    const lines = error.mock.calls.map((call) => call.join(' '));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith('error: '))).toBe(true);
    expect(lines.some((line) => line.includes('org:typo'))).toBe(true);
  });
});

describe('build failure disclosure', () => {
  const SENTINEL = 'SENTINEL-apiversion-value';

  async function sentinelFixture() {
    const options = await buildFixture({ node: NODE_PORTS });
    await writeFile(
      options.configPath,
      `export default { platform: 'node', plugins: [{ id: 'widgets', package: '@test/widgets', apiVersion: ${JSON.stringify(SENTINEL)}, platforms: ['node'] }], platformPorts: { node: ${JSON.stringify(NODE_PORTS)} } };`,
    );
    return options;
  }

  it('prints the error name and config key and exits 1 without the invalid value', async () => {
    const options = await sentinelFixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'cwd').mockReturnValue(options.cwd);
    const argv = process.argv;
    process.argv = ['node', 'pb', 'build', '--config', options.configPath];
    try {
      vi.resetModules();
      await import('./bin.js');
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    } finally {
      process.argv = argv;
    }
    expect(exit).toHaveBeenCalledWith(1);
    const printed = error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).not.toContain(SENTINEL);
    expect(printed).toBe('error: Error: invalid broker config: plugins.apiVersion');
  });

  it('reports the invalid platform port key without its value', async () => {
    const options = await buildFixture({
      node: { ...NODE_PORTS, blob: { ...NODE_PORTS.blob, rootEnv: SENTINEL } },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'cwd').mockReturnValue(options.cwd);
    const failure: unknown = await run(['build', '--config', options.configPath]).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: 'Error',
      configKeys: [
        'node.blob.rootEnv: invalid env reference name',
        'node.blob.rootEnv: looks like a credential value',
      ],
    });
    expect(String(failure)).not.toContain(SENTINEL);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('build route diagnostics after registration', () => {
  it('exits 2 and writes no manifest when diagnoseRoutes rejects a config the kernel accepted', async () => {
    const options = await routeFixture('org:read');
    vi.mocked(diagnoseRoutes).mockReturnValueOnce([
      'Route GET /widgets (plugin "widgets"): synthetic',
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(options.cwd);
    try {
      expect(await run(['build', '--config', options.configPath])).toBe(2);
    } finally {
      cwd.mockRestore();
    }
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual([
      'error: Route GET /widgets (plugin "widgets"): synthetic',
    ]);
    await expect(
      readFile(path.join(options.cwd, '.pb', 'node', 'generated', 'manifest.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
