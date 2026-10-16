import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { afterEach, describe, expect, it } from 'vitest';
import { toManifestMigrations } from './build-artifacts.js';
import { BuiltManifestError, loadBuiltMigrations } from './commands/built-manifest.js';
import { renderManifestJson, type Manifest } from './manifest.js';

const CORE_SQL = 'CREATE TABLE core_items (id TEXT PRIMARY KEY);\n';
const PLUGIN_SQL = 'CREATE TABLE github_repos (id TEXT PRIMARY KEY);\n';

const dirs: string[] = [];

afterEach(async () => {
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
