import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@package-broker/db-sqlite/migrations/source';
import { afterEach, describe, expect, it } from 'vitest';
import { BuiltManifestError, loadBuiltMigrations } from './built-manifest.js';

interface Entry {
  id: string;
  name: string;
  checksum: string;
  phase: string;
}

const INIT_URL = new URL('../../../db-sqlite/migrations/0001_init.sql', import.meta.url);
const dirs: string[] = [];

async function entryFor(
  owner: string,
  name: string,
  sql: string,
  phase = 'expand',
): Promise<Entry> {
  return {
    id: `${owner}:${name.replace(/\.sql$/, '')}`,
    name,
    checksum: await sha256Hex(sql.replace(/\r\n/g, '\n')),
    phase,
  };
}

async function build(
  manifest: (core: Entry) => unknown | Promise<unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'pb-built-'));
  dirs.push(outDir);
  const initSql = await readFile(INIT_URL, 'utf8');
  await mkdir(join(outDir, 'generated'), { recursive: true });
  await mkdir(join(outDir, 'migrations', 'core'), { recursive: true });
  await writeFile(join(outDir, 'migrations', 'core', '0001_init.sql'), initSql);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(join(outDir, 'migrations', relative, '..'), { recursive: true });
    await writeFile(join(outDir, 'migrations', relative), text);
  }
  const core = await entryFor('core', '0001_init.sql', initSql);
  await writeFile(join(outDir, 'generated', 'manifest.json'), JSON.stringify(await manifest(core)));
  return outDir;
}

const manifestOf = (migrations: unknown, schemaVersion: unknown = 1) => ({
  schemaVersion,
  migrations,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PLUGIN_SQL = 'CREATE TABLE github_a (id INTEGER);\n';
const CONTRACT_SQL = '-- pb:phase contract\nCREATE TABLE github_a (id INTEGER);\n';

describe('loadBuiltMigrations', () => {
  it('loads a valid manifest in owner appearance order', async () => {
    const outDir = await build(
      async (core) => manifestOf([core, await entryFor('github', '0001_a.sql', PLUGIN_SQL)]),
      { 'github/0001_a.sql': PLUGIN_SQL },
    );

    const sources = await loadBuiltMigrations(outDir);

    expect(sources.map((source) => source.id)).toEqual(['core:0001_init', 'github:0001_a']);
    expect(sources[0]?.phase).toBe('expand');
  });

  it('plans owners by manifest appearance order and sequences within each owner', async () => {
    const sql = (table: string) => `CREATE TABLE ${table} (id INTEGER);\n`;
    const layout: [string, string][] = [
      ['core', '0002_b.sql'],
      ['zeta', '0002_b.sql'],
      ['alpha', '0003_c.sql'],
      ['zeta', '0001_a.sql'],
      ['alpha', '0001_a.sql'],
    ];
    const files: Record<string, string> = {};
    const outDir = await build(async (core) => {
      const entries: Entry[] = [];
      for (const [owner, name] of layout) {
        const text = sql(`${owner}_${name.slice(0, 4)}`);
        files[`${owner}/${name}`] = text;
        entries.push(await entryFor(owner, name, text));
      }
      return manifestOf([core, ...entries]);
    }, files);
    await mkdir(join(outDir, 'migrations', 'zeta'), { recursive: true });
    await mkdir(join(outDir, 'migrations', 'alpha'), { recursive: true });
    for (const [relative, text] of Object.entries(files)) {
      await writeFile(join(outDir, 'migrations', relative), text);
    }

    const sources = await loadBuiltMigrations(outDir);

    expect(sources.map((source) => source.id)).toEqual([
      'core:0001_init',
      'core:0002_b',
      'zeta:0001_a',
      'zeta:0002_b',
      'alpha:0001_a',
      'alpha:0003_c',
    ]);
  });

  const failures: [string, (core: Entry) => unknown | Promise<unknown>, Record<string, string>?][] =
    [
      ['wrong schemaVersion', (core) => manifestOf([core], 2)],
      ['migrations not an array', () => manifestOf({})],
      [
        'upper-case checksum',
        (core) => manifestOf([{ ...core, checksum: core.checksum.toUpperCase() }]),
      ],
      ['id and name disagree', (core) => manifestOf([{ ...core, name: '0001_other.sql' }])],
      ['duplicate id', (core) => manifestOf([core, core])],
      ['name with path traversal', (core) => manifestOf([{ ...core, name: '../0001_x.sql' }])],
      ['owner ..', (core) => manifestOf([core, { ...core, id: '..:0001_x', name: '0001_x.sql' }])],
      ['non-string checksum', (core) => manifestOf([{ ...core, checksum: 5 }])],
      ['unknown phase value', (core) => manifestOf([{ ...core, phase: 'sideways' }])],
      ['entry not an object', (core) => manifestOf([core, 'core:0002_x'])],
      [
        'phase mismatch',
        async (core) =>
          manifestOf([
            core,
            { ...(await entryFor('github', '0001_a.sql', CONTRACT_SQL)), phase: 'expand' },
          ]),
        { 'github/0001_a.sql': CONTRACT_SQL },
      ],
      [
        'checksum mismatch',
        async (core) =>
          manifestOf([
            core,
            { ...(await entryFor('github', '0001_a.sql', PLUGIN_SQL)), checksum: 'a'.repeat(64) },
          ]),
        { 'github/0001_a.sql': PLUGIN_SQL },
      ],
      [
        'missing file',
        async (core) => manifestOf([core, await entryFor('github', '0001_a.sql', PLUGIN_SQL)]),
      ],
      [
        'no core:0001_init',
        async () => manifestOf([await entryFor('github', '0001_a.sql', PLUGIN_SQL)]),
        { 'github/0001_a.sql': PLUGIN_SQL },
      ],
    ];

  it.each(failures)('rejects %s', async (_label, manifest, files) => {
    const outDir = await build(manifest, files);

    await expect(loadBuiltMigrations(outDir)).rejects.toBeInstanceOf(BuiltManifestError);
  });

  it('reports the missing core init migration when core is listed first', async () => {
    const text = 'CREATE TABLE core_other (id INTEGER);\n';
    const outDir = await build(
      async () => manifestOf([await entryFor('core', '0002_other.sql', text)]),
      { 'core/0002_other.sql': text },
    );

    await expect(loadBuiltMigrations(outDir)).rejects.toThrow(/core:0001_init.*missing/);
  });

  it('rejects a missing manifest and invalid JSON', async () => {
    const outDir = await build((core) => manifestOf([core]));
    await writeFile(join(outDir, 'generated', 'manifest.json'), '{');

    await expect(loadBuiltMigrations(outDir)).rejects.toBeInstanceOf(BuiltManifestError);
    await rm(join(outDir, 'generated', 'manifest.json'));
    await expect(loadBuiltMigrations(outDir)).rejects.toBeInstanceOf(BuiltManifestError);
  });
});
