import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource } from './source.js';
import { planMigrations } from './plan.js';

const baselineUrl = new URL('../../migrations/0001_init.sql', import.meta.url);
let opened: OpenedExecutor | undefined;
async function freshExecutor(): Promise<SqlExecutor> {
  opened = openNodeSqliteExecutor();
  return opened.executor;
}
afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const mismatch = 'package ecosystem does not match source ecosystem';
const locked = 'source ecosystem cannot change while the source holds packages';
const triggerNames = [
  'package_ecosystem_matches_source_insert',
  'package_ecosystem_matches_source_update',
  'source_ecosystem_locked_with_packages',
];
const sql = readFileSync(baselineUrl, 'utf8');
let executor: SqlExecutor;
const run = (sql: string, ...params: (string | number)[]) => executor.all({ sql, params });
const triggers = () =>
  executor.all<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    params: [],
  });

async function seed(): Promise<void> {
  await run("INSERT INTO organization (id, slug, name) VALUES ('O', 'org', 'Organization')");
  await run(`INSERT INTO source (id, org_id, name, ecosystem, type) VALUES
    ('C', 'O', 'Composer', 'composer', 'hosted'),
    ('C2', 'O', 'Composer 2', 'composer', 'hosted'),
    ('N', 'O', 'npm', 'npm', 'hosted')`);
}

async function insert(ecosystem = 'composer', source = 'C'): Promise<void> {
  await run(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    'K',
    'O',
    source,
    ecosystem,
    'acme/widget',
  );
}

describe('package/source ecosystem database guards', () => {
  beforeEach(async () => {
    executor = await freshExecutor();
    await migrate(executor, [await loadMigrationSource('core', '0001_init.sql', sql)], {
      holder: 'ecosystem-test',
    });
    await seed();
  });

  it('accepts a matching package insert', async () => {
    await insert();
    expect(await run("SELECT ecosystem FROM package WHERE org_id = 'O' AND id = 'K'")).toEqual([
      { ecosystem: 'composer' },
    ]);
  });

  it('refuses a mismatched package insert', async () => {
    await expect(insert('npm')).rejects.toThrow(mismatch);
    expect(await run('SELECT id FROM package')).toEqual([]);
  });

  it('refuses an insert with a missing source as a mismatch', async () => {
    await expect(insert('composer', 'missing')).rejects.toThrow(mismatch);
  });

  it('refuses moving a package to a source of another ecosystem', async () => {
    await insert();
    await expect(
      run("UPDATE package SET source_id = 'N' WHERE org_id = 'O' AND id = 'K'"),
    ).rejects.toThrow(mismatch);
    expect(await run("SELECT source_id FROM package WHERE org_id = 'O' AND id = 'K'")).toEqual([
      { source_id: 'C' },
    ]);
  });

  it('refuses changing a package ecosystem away from its source', async () => {
    await insert();
    await expect(
      run("UPDATE package SET ecosystem = 'npm' WHERE org_id = 'O' AND id = 'K'"),
    ).rejects.toThrow(mismatch);
  });

  it('refuses moving a package to a missing source', async () => {
    await insert();
    await expect(
      run("UPDATE package SET source_id = 'missing' WHERE org_id = 'O' AND id = 'K'"),
    ).rejects.toThrow(mismatch);
  });

  it('allows equal ecosystems, a same-ecosystem move and a matching two-column move', async () => {
    await insert();
    await run("UPDATE package SET ecosystem = ecosystem WHERE org_id = 'O' AND id = 'K'");
    await run("UPDATE package SET source_id = 'C2' WHERE org_id = 'O' AND id = 'K'");
    await run(
      "UPDATE package SET source_id = 'N', ecosystem = 'npm' WHERE org_id = 'O' AND id = 'K'",
    );
    expect(
      await run("SELECT source_id, ecosystem FROM package WHERE org_id = 'O' AND id = 'K'"),
    ).toEqual([{ source_id: 'N', ecosystem: 'npm' }]);
  });

  it('allows changing another package column', async () => {
    await insert();
    await run("UPDATE package SET description = 'Updated' WHERE org_id = 'O' AND id = 'K'");
    expect(await run("SELECT description FROM package WHERE org_id = 'O' AND id = 'K'")).toEqual([
      { description: 'Updated' },
    ]);
  });

  it('refuses changing a source ecosystem while it holds packages', async () => {
    await insert();
    await expect(
      run("UPDATE source SET ecosystem = 'npm' WHERE org_id = 'O' AND id = 'C'"),
    ).rejects.toThrow(locked);
    expect(await run("SELECT ecosystem FROM source WHERE org_id = 'O' AND id = 'C'")).toEqual([
      { ecosystem: 'composer' },
    ]);
  });

  it('allows changing an empty source ecosystem', async () => {
    await run("UPDATE source SET ecosystem = 'npm' WHERE org_id = 'O' AND id = 'C'");
    expect(await run("SELECT ecosystem FROM source WHERE org_id = 'O' AND id = 'C'")).toEqual([
      { ecosystem: 'npm' },
    ]);
  });

  it('allows changing another source column and keeping its ecosystem', async () => {
    await insert();
    await run(
      "UPDATE source SET name = 'Updated', ecosystem = ecosystem WHERE org_id = 'O' AND id = 'C'",
    );
    expect(await run("SELECT name FROM source WHERE org_id = 'O' AND id = 'C'")).toEqual([
      { name: 'Updated' },
    ]);
  });

  it('records only the fresh baseline and reruns without changes', async () => {
    const result = await migrate(
      executor,
      [await loadMigrationSource('core', '0001_init.sql', sql)],
      { holder: 'ecosystem-rerun' },
    );
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['core:0001_init']);
    expect((await triggers()).map(({ name }) => name)).toEqual(triggerNames);
  });
});

describe('guard installation preflight and migration atomicity', () => {
  async function unguarded() {
    executor = await freshExecutor();
    const start = sql.indexOf('CREATE TRIGGER package_ecosystem_matches_source_update');
    expect(start).toBeGreaterThan(0);
    // Exercise the shipped guard suffix on populated fixtures without adding a production migration.
    const baseline = await loadMigrationSource('core', '0001_init.sql', sql.slice(0, start));
    const guard = await loadMigrationSource('core', '0002_guard_fixture.sql', sql.slice(start));
    const plan = await planMigrations([baseline, guard], ['core']);
    expect(guard.phase).toBe('expand');
    await migrate(executor, [baseline], { holder: 'ecosystem-unguarded' });
    return { baseline, guard, plan };
  }

  it('aborts on a mismatch without recording the guard or leaving triggers or data changes', async () => {
    const { baseline, plan } = await unguarded();
    await seed();
    await insert('npm');
    const before = await run('SELECT * FROM package');
    const sourcesBefore = await run('SELECT * FROM source ORDER BY id');
    const schemaBefore = await run('SELECT type, name, sql FROM sqlite_master ORDER BY type, name');
    await expect(migrate(executor, plan, { holder: 'ecosystem-preflight' })).rejects.toThrow(
      mismatch,
    );
    expect(await run('SELECT * FROM package')).toEqual(before);
    expect(await run('SELECT * FROM source ORDER BY id')).toEqual(sourcesBefore);
    expect(await triggers()).toEqual([]);
    expect(await run('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')).toEqual(
      schemaBefore,
    );
    expect(await run('SELECT id FROM schema_migration')).toEqual([{ id: baseline.id }]);
  });

  it.each(['empty', 'matching'])('applies to %s rows and reruns as a no-op', async (state) => {
    const { guard, plan } = await unguarded();
    if (state === 'matching') {
      await seed();
      await insert();
    }
    const before = await run('SELECT * FROM package');
    const result = await migrate(executor, plan, { holder: 'ecosystem-preflight' });
    expect(result.applied).toEqual([guard.id]);
    expect((await triggers()).map(({ name }) => name)).toEqual(triggerNames);
    expect(await run('SELECT * FROM package')).toEqual(before);
    expect((await migrate(executor, plan, { holder: 'ecosystem-rerun' })).applied).toEqual([]);
  });
});
