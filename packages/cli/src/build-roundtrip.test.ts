import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from './build.js';
import { toManifestMigrations } from './build-artifacts.js';
import { BuiltManifestError, loadBuiltMigrations } from './commands/built-manifest.js';
import { renderManifestJson, type Manifest } from './manifest.js';

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
