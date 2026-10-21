import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlValue } from '@package-broker/core/db/port';
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';
import { BACKUP_SCOPE } from '../backup-scope.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource, type MigrationSource } from './source.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);

async function loadCore(only: (name: string) => boolean = () => true): Promise<MigrationSource[]> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql') && only(name))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

const ORG = '01J0ACME000000000000000000';
const PROJECT = '01J0PROJ000000000000000000';
const SOURCE = '01J0SRCE000000000000000000';
const PACKAGE = '01J0PACK000000000000000000';
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const NOW = '2026-10-16T09:00:00.000Z';
const TABLES = ['ingest_session', 'upstream_state', 'fetch_lease', 'representation_clock'];

let opened: OpenedExecutor;

beforeEach(() => {
  opened = openNodeSqliteExecutor();
});

afterEach(async () => {
  await opened.close();
});

async function rows<R>(sql: string, params: readonly SqlValue[] = []): Promise<R[]> {
  return opened.executor.all<R>({ sql, params });
}

async function run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
  await opened.executor.all({ sql, params });
}

async function seed(): Promise<void> {
  await run('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [ORG, 'acme', 'Acme']);
  await run('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    PROJECT,
    ORG,
    'main',
    'Main',
  ]);
  await run('INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)', [
    SOURCE,
    ORG,
    'packagist',
    'composer',
    'packagist_proxy',
  ]);
  await run('INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)', [
    PACKAGE,
    ORG,
    SOURCE,
    'composer',
    'acme/lib',
  ]);
}

async function insert(table: string, columns: Record<string, SqlValue>): Promise<void> {
  const names = Object.keys(columns);
  await run(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(columns),
  );
}

function session(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
  return {
    id: '01J0SESS000000000000000000',
    org_id: ORG,
    scope: 'source',
    scope_key: KEY,
    source_id: SOURCE,
    generation: 1,
    owner: 'worker-1',
    fence: 1,
    lease_until: NOW,
    state: 'running',
    started_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function upstream(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
  return {
    org_id: ORG,
    package_id: PACKAGE,
    form: 'composer-p2',
    checked_at: NOW,
    fresh_until: NOW,
    ...overrides,
  };
}

function lease(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
  return {
    org_id: ORG,
    lease_key: KEY,
    owner: 'worker-1',
    fence: 1,
    lease_until: NOW,
    acquired_at: NOW,
    ...overrides,
  };
}

function clock(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
  return {
    org_id: ORG,
    project_id: PROJECT,
    key_hash: KEY,
    form: 'composer-p2',
    validator: OTHER_KEY,
    last_modified: NOW,
    ...overrides,
  };
}

const CHECK = /CHECK constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;
const FOREIGN_KEY = /FOREIGN KEY constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

async function columns(table: string): Promise<Column[]> {
  return rows<Column>(`SELECT name, type, "notnull", pk FROM pragma_table_info('${table}')`);
}

async function tableList(table: string): Promise<{ strict: number; wr: number }> {
  const [row] = await rows<{ strict: number; wr: number }>(
    `SELECT strict, wr FROM pragma_table_list('${table}')`,
  );
  if (row === undefined) throw new Error(`${table} is missing`);
  return row;
}

async function indexNames(
  table: string,
): Promise<{ name: string; unique: number; partial: number }[]> {
  return rows(
    `SELECT name, "unique", partial FROM pragma_index_list('${table}') WHERE origin = 'c' ORDER BY name`,
  );
}

async function migrateTo(upTo: string | null): Promise<void> {
  const sources = await loadCore((name) => upTo === null || name < upTo);
  await migrate(opened.executor, sources, { holder: 'registry-migration-test' });
}

describe('migration 0023 version package status index', () => {
  const migrationId = 'core:0023_version_package_status';

  it.each(['fresh', 'upgrade'])('applies to a %s database', async (mode) => {
    const sources = await loadCore((name) => name < '0024_');
    if (mode === 'upgrade') {
      await migrate(
        opened.executor,
        sources.filter((source) => source.id < migrationId),
        {
          holder: 'version-status-test',
        },
      );
    }
    const result = await migrate(opened.executor, sources, { holder: 'version-status-test' });
    expect(result.applied.at(-1)).toBe(migrationId);
    if (mode === 'upgrade') expect(result.applied).toEqual([migrationId]);
    expect(await indexNames('version')).toContainEqual({
      name: 'version_package_status',
      unique: 0,
      partial: 0,
    });
    expect(await rows('SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1')).toEqual([
      { id: migrationId },
    ]);
  });

  it('skips an already applied migration', async () => {
    const sources = await loadCore();
    await migrate(opened.executor, sources, { holder: 'version-status-test' });
    const result = await migrate(opened.executor, sources, { holder: 'version-status-test' });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain(migrationId);
  });

  it('does not change the schema when the index SQL is reapplied', async () => {
    await migrateTo(null);
    const before = await rows('PRAGMA schema_version');
    const sql = readFileSync(new URL('0023_version_package_status.sql', migrationsUrl), 'utf8');
    await run(sql);
    expect(await rows('PRAGMA schema_version')).toEqual(before);
    expect(await indexNames('version')).toContainEqual({
      name: 'version_package_status',
      unique: 0,
      partial: 0,
    });
  });

  it('uses the index for a quarantined version existence probe', async () => {
    await migrateTo(null);
    const plan = await rows<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT 1 FROM version WHERE package_id = ? AND status = 'quarantined' LIMIT 1",
      [PACKAGE],
    );
    expect(plan.some((step) => step.detail.includes('version_package_status'))).toBe(true);
  });
});

describe.each([
  ['a fresh database', async () => migrateTo('0008_')],
  [
    'a database migrated to 0006',
    async () => {
      await migrateTo('0007_');
      await migrateTo('0008_');
    },
  ],
])('migration 0007 on %s', (_label, prepare) => {
  beforeEach(async () => {
    await prepare();
  });

  it('creates the four tables as STRICT, the keyed ones WITHOUT ROWID', async () => {
    expect(await tableList('ingest_session')).toMatchObject({ strict: 1, wr: 0 });
    for (const table of ['upstream_state', 'fetch_lease', 'representation_clock']) {
      expect(await tableList(table)).toMatchObject({ strict: 1, wr: 1 });
    }
  });

  it('matches the specified columns', async () => {
    const shape = async (table: string) =>
      (await columns(table)).map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`);
    expect(await shape('ingest_session')).toEqual([
      'id:TEXT:1:1',
      'org_id:TEXT:1:0',
      'scope:TEXT:1:0',
      'scope_key:TEXT:1:0',
      'source_id:TEXT:1:0',
      'package_key:TEXT:0:0',
      'generation:INTEGER:1:0',
      'owner:TEXT:1:0',
      'fence:INTEGER:1:0',
      'lease_until:TEXT:1:0',
      'state:TEXT:1:0',
      'snapshot_id:TEXT:0:0',
      'snapshot_blob_sha256:TEXT:0:0',
      'stamp:TEXT:0:0',
      'cursor:TEXT:0:0',
      'seen_count:INTEGER:1:0',
      'pending_validators:TEXT:0:0',
      'pages_so_far:INTEGER:1:0',
      'started_at:TEXT:1:0',
      'updated_at:TEXT:1:0',
    ]);
    expect(await shape('upstream_state')).toEqual([
      'org_id:TEXT:1:0',
      'package_id:TEXT:1:1',
      'form:TEXT:1:2',
      'etag:TEXT:0:0',
      'last_modified:TEXT:0:0',
      'content_sha256:TEXT:0:0',
      'checked_at:TEXT:1:0',
      'fresh_until:TEXT:1:0',
      'not_found_count:INTEGER:1:0',
      'first_not_found_at:TEXT:0:0',
    ]);
    expect(await shape('fetch_lease')).toEqual([
      'org_id:TEXT:1:0',
      'lease_key:TEXT:1:1',
      'owner:TEXT:1:0',
      'fence:INTEGER:1:0',
      'lease_until:TEXT:1:0',
      'acquired_at:TEXT:1:0',
    ]);
    expect(await shape('representation_clock')).toEqual([
      'org_id:TEXT:1:0',
      'project_id:TEXT:1:1',
      'key_hash:TEXT:1:2',
      'form:TEXT:1:3',
      'validator:TEXT:1:0',
      'last_modified:TEXT:1:0',
    ]);
  });

  it('declares the two ingest_session indexes', async () => {
    expect(await indexNames('ingest_session')).toEqual([
      { name: 'ingest_session_running_scope', unique: 1, partial: 1 },
      { name: 'ingest_session_scope_generation', unique: 0, partial: 0 },
      { name: 'ingest_session_state_lease', unique: 0, partial: 0 },
    ]);
    expect(await indexNames('fetch_lease')).toEqual([
      { name: 'fetch_lease_expiry', unique: 0, partial: 0 },
    ]);
    const generation = await rows<{ name: string }>(
      "SELECT name FROM pragma_index_info('ingest_session_scope_generation') ORDER BY seqno",
    );
    expect(generation.map((c) => c.name)).toEqual(['org_id', 'scope_key', 'generation']);
    const [state] = await rows<{ name: string }>(
      "SELECT name FROM pragma_index_info('ingest_session_state_lease') ORDER BY seqno",
    );
    expect(state?.name).toBe('state');
  });

  it('classifies the four tables exactly once, all excluded', () => {
    for (const table of TABLES) {
      expect(Object.keys(BACKUP_SCOPE).filter((name) => name === table)).toEqual([table]);
      expect(BACKUP_SCOPE[table]).toBe('exclude');
    }
  });

  describe('ingest_session checks', () => {
    beforeEach(seed);

    it('accepts a valid row with defaults', async () => {
      await insert('ingest_session', session());
      expect(await rows('SELECT seen_count, pages_so_far FROM ingest_session')).toEqual([
        { seen_count: 0, pages_so_far: 0 },
      ]);
    });

    it.each<[string, Record<string, SqlValue>, RegExp]>([
      ['an unknown scope', { scope: 'org' }, CHECK],
      ['a 63-character scope_key', { scope_key: 'a'.repeat(63) }, CHECK],
      ['an uppercase scope_key', { scope_key: 'A'.repeat(64) }, CHECK],
      ['a non-hex scope_key', { scope_key: 'g'.repeat(64) }, CHECK],
      ['generation 0', { generation: 0 }, CHECK],
      ['fence 0', { fence: 0 }, CHECK],
      ['an unknown state', { state: 'done' }, CHECK],
      ['an oversized cursor', { cursor: 'x'.repeat(4097) }, CHECK],
      ['a negative seen_count', { seen_count: -1 }, CHECK],
      ['a negative pages_so_far', { pages_so_far: -1 }, CHECK],
      ['invalid pending_validators JSON', { pending_validators: '{nope' }, CHECK],
      ['pending_validators that is an array', { pending_validators: '[1]' }, CHECK],
      ['pending_validators that is a string', { pending_validators: '"x"' }, CHECK],
      ['an uppercase snapshot_blob_sha256', { snapshot_blob_sha256: 'A'.repeat(64) }, CHECK],
      ['a short snapshot_blob_sha256', { snapshot_blob_sha256: 'a'.repeat(63) }, CHECK],
      ['a non-hex snapshot_blob_sha256', { snapshot_blob_sha256: 'g'.repeat(64) }, CHECK],
      ['a package scope without package_key', { scope: 'package' }, CHECK],
      ['a source scope with a package_key', { package_key: 'acme/lib' }, CHECK],
      ['a missing owner', { owner: null }, NOT_NULL],
      ['an unknown source', { source_id: 'missing' }, FOREIGN_KEY],
      ['an unknown organization', { org_id: 'missing' }, FOREIGN_KEY],
    ])('refuses %s', async (_name, overrides, error) => {
      await expect(insert('ingest_session', session(overrides))).rejects.toThrow(error);
    });

    it('accepts a 4096-character cursor, object validators, a digest and a package scope', async () => {
      await insert(
        'ingest_session',
        session({
          cursor: 'x'.repeat(4096),
          pending_validators: '{"a":1}',
          snapshot_blob_sha256: KEY,
        }),
      );
      await insert(
        'ingest_session',
        session({
          id: '01J0SESS000000000000000009',
          scope: 'package',
          scope_key: OTHER_KEY,
          package_key: 'acme/lib',
        }),
      );
    });

    it('refuses two running sessions with the same org and scope_key', async () => {
      await insert('ingest_session', session());
      await expect(
        insert('ingest_session', session({ id: '01J0SESS000000000000000001' })),
      ).rejects.toThrow(UNIQUE);
    });

    it('lets a complete session and a running one coexist, and other keys run in parallel', async () => {
      await insert('ingest_session', session({ state: 'complete' }));
      await insert('ingest_session', session({ id: '01J0SESS000000000000000001' }));
      await insert(
        'ingest_session',
        session({ id: '01J0SESS000000000000000002', scope_key: OTHER_KEY }),
      );
      await insert(
        'ingest_session',
        session({ id: '01J0SESS000000000000000003', state: 'abandoned' }),
      );
      expect(await rows('SELECT id FROM ingest_session')).toHaveLength(4);
    });

    it('is deleted with its source', async () => {
      await insert('ingest_session', session());
      await run('DELETE FROM package WHERE id = ?', [PACKAGE]);
      await run('DELETE FROM source WHERE id = ?', [SOURCE]);
      expect(await rows('SELECT id FROM ingest_session')).toEqual([]);
    });
  });

  describe('upstream_state checks', () => {
    beforeEach(seed);

    it('accepts every form with defaults', async () => {
      for (const form of [
        'composer-p2',
        'composer-p2-dev',
        'composer-v1-provider',
        'npm-packument',
      ]) {
        await insert('upstream_state', upstream({ form }));
      }
      expect(await rows('SELECT not_found_count FROM upstream_state')).toHaveLength(4);
    });

    it.each<[string, Record<string, SqlValue>, RegExp]>([
      ['an unknown form', { form: 'composer-v1' }, CHECK],
      ['an uppercase digest', { content_sha256: 'A'.repeat(64) }, CHECK],
      ['a 63-character digest', { content_sha256: 'a'.repeat(63) }, CHECK],
      ['a non-hex digest', { content_sha256: 'g'.repeat(64) }, CHECK],
      ['a negative not_found_count', { not_found_count: -1 }, CHECK],
      ['a missing checked_at', { checked_at: null }, NOT_NULL],
      ['an unknown package', { package_id: 'missing' }, FOREIGN_KEY],
      ['an unknown organization', { org_id: 'missing' }, FOREIGN_KEY],
    ])('refuses %s', async (_name, overrides, error) => {
      await expect(insert('upstream_state', upstream(overrides))).rejects.toThrow(error);
    });

    it('accepts a lowercase digest and refuses a duplicate package and form', async () => {
      await insert('upstream_state', upstream({ content_sha256: KEY }));
      await expect(insert('upstream_state', upstream())).rejects.toThrow(UNIQUE);
    });

    it('is deleted with its package', async () => {
      await insert('upstream_state', upstream());
      await run('DELETE FROM package WHERE id = ?', [PACKAGE]);
      expect(await rows('SELECT package_id FROM upstream_state')).toEqual([]);
    });
  });

  describe('fetch_lease checks', () => {
    beforeEach(seed);

    it.each<[string, Record<string, SqlValue>, RegExp]>([
      ['a 63-character key', { lease_key: 'a'.repeat(63) }, CHECK],
      ['an uppercase key', { lease_key: 'A'.repeat(64) }, CHECK],
      ['a non-hex key', { lease_key: 'g'.repeat(64) }, CHECK],
      ['fence 0', { fence: 0 }, CHECK],
      ['a missing owner', { owner: null }, NOT_NULL],
      ['an unknown organization', { org_id: 'missing' }, FOREIGN_KEY],
    ])('refuses %s', async (_name, overrides, error) => {
      await expect(insert('fetch_lease', lease(overrides))).rejects.toThrow(error);
    });

    it('refuses a second lease with the same key', async () => {
      await insert('fetch_lease', lease());
      await expect(insert('fetch_lease', lease())).rejects.toThrow(UNIQUE);
    });
  });

  describe('representation_clock checks', () => {
    beforeEach(seed);

    it('accepts both forms', async () => {
      await insert('representation_clock', clock());
      await insert('representation_clock', clock({ form: 'composer-p2-dev' }));
    });

    it.each<[string, Record<string, SqlValue>, RegExp]>([
      ['an unsupported form', { form: 'npm-packument' }, CHECK],
      ['an uppercase key_hash', { key_hash: 'A'.repeat(64) }, CHECK],
      ['a short key_hash', { key_hash: 'a'.repeat(63) }, CHECK],
      ['a non-hex key_hash', { key_hash: 'g'.repeat(64) }, CHECK],
      ['an uppercase validator', { validator: 'B'.repeat(64) }, CHECK],
      ['a short validator', { validator: 'b'.repeat(63) }, CHECK],
      ['a non-hex validator', { validator: 'g'.repeat(64) }, CHECK],
      ['a missing last_modified', { last_modified: null }, NOT_NULL],
      ['an unknown project', { project_id: 'missing' }, FOREIGN_KEY],
      ['an unknown organization', { org_id: 'missing' }, FOREIGN_KEY],
    ])('refuses %s', async (_name, overrides, error) => {
      await expect(insert('representation_clock', clock(overrides))).rejects.toThrow(error);
    });

    it('is deleted with its project', async () => {
      await insert('representation_clock', clock());
      await run('DELETE FROM project WHERE id = ?', [PROJECT]);
      expect(await rows('SELECT project_id FROM representation_clock')).toEqual([]);
    });
  });
});

describe('migration 0024 closure edge indexes', () => {
  const migrationId = 'core:0024_closure_edge_indexes';
  it.each(['fresh', 'upgrade'])(
    'applies on %s databases and preserves org-consistent keys',
    async (mode) => {
      if (mode === 'upgrade') {
        await migrateTo('0024_');
        await seed();
        await run('DROP INDEX organization_singleton');
        await insert('organization', { id: 'OTHER', slug: 'other', name: 'Other' });
        await insert('project', { id: 'OTHER-P', org_id: 'OTHER', slug: 'other', name: 'Other' });
        await insert('source', {
          id: 'OTHER-S',
          org_id: 'OTHER',
          name: 'npm',
          ecosystem: 'npm',
          type: 'npm_registry',
        });
        await insert('package', {
          id: 'OTHER-K',
          org_id: 'OTHER',
          source_id: 'OTHER-S',
          ecosystem: 'npm',
          name: '@other/lib',
        });
        await insert('project_package', {
          org_id: 'OTHER',
          project_id: 'OTHER-P',
          package_id: 'OTHER-K',
          origin: 'pattern',
          created_at: NOW,
        });
        await run(
          "INSERT INTO project_package (org_id, project_id, package_id, origin, created_at) VALUES (?, ?, ?, 'explicit', ?)",
          [ORG, PROJECT, PACKAGE, NOW],
        );
      }
      const result = await migrate(opened.executor, await loadCore(), {
        holder: 'edge-index-test',
      });
      expect(result.applied.at(-1)).toBe(migrationId);
      if (mode === 'upgrade') {
        expect(result.applied).toEqual([migrationId]);
        expect(
          await rows(
            'SELECT org_id, project_id, package_id, origin, created_at, ecosystem, name FROM project_package ORDER BY org_id',
          ),
        ).toEqual([
          {
            org_id: ORG,
            project_id: PROJECT,
            package_id: PACKAGE,
            origin: 'explicit',
            created_at: NOW,
            ecosystem: 'composer',
            name: 'acme/lib',
          },
          {
            org_id: 'OTHER',
            project_id: 'OTHER-P',
            package_id: 'OTHER-K',
            origin: 'pattern',
            created_at: NOW,
            ecosystem: 'npm',
            name: '@other/lib',
          },
        ]);
      }
      expect(await rows('PRAGMA foreign_key_check')).toEqual([]);
      expect(
        await rows(`SELECT id, seq, "table", "from", "to", on_update, on_delete, match
        FROM pragma_foreign_key_list('project_package') ORDER BY id, seq`),
      ).toEqual([
        {
          id: 0,
          seq: 0,
          table: 'package',
          from: 'org_id',
          to: 'org_id',
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
        {
          id: 0,
          seq: 1,
          table: 'package',
          from: 'package_id',
          to: 'id',
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
        {
          id: 1,
          seq: 0,
          table: 'project',
          from: 'org_id',
          to: 'org_id',
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
        {
          id: 1,
          seq: 1,
          table: 'project',
          from: 'project_id',
          to: 'id',
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
        {
          id: 2,
          seq: 0,
          table: 'organization',
          from: 'org_id',
          to: 'id',
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
      ]);
      if (mode === 'fresh') await seed();
      await expect(
        insert('project_package', {
          org_id: ORG,
          project_id: PROJECT,
          package_id: PACKAGE,
          origin: 'invalid',
          ecosystem: 'composer',
          name: 'acme/lib',
        }),
      ).rejects.toThrow(CHECK);

      expect(await tableList('project_package')).toMatchObject({ strict: 1, wr: 1 });
      expect(
        (await columns('project_package'))
          .filter((c) => ['ecosystem', 'name'].includes(c.name))
          .map((c) => [c.name, c.notnull]),
      ).toEqual([
        ['ecosystem', 1],
        ['name', 1],
      ]);
      expect(await indexNames('project_package')).toEqual([
        { name: 'project_package_name', unique: 0, partial: 0 },
        { name: 'project_package_package', unique: 0, partial: 0 },
      ]);
    },
  );

  it.each(['missing', 'foreign'])(
    'aborts when the linked package is %s in the row organization',
    async (kind) => {
      await migrateTo('0024_');
      await seed();
      await run('DROP INDEX organization_singleton');
      await insert('organization', { id: 'OTHER', slug: 'other', name: 'Other' });
      await insert('project', { id: 'OTHER-P', org_id: 'OTHER', slug: 'other', name: 'Other' });
      await withForeignKeysOff(opened.executor, () =>
        insert('project_package', {
          org_id: 'OTHER',
          project_id: 'OTHER-P',
          package_id: kind === 'missing' ? 'missing' : PACKAGE,
          origin: 'explicit',
          created_at: NOW,
        }),
      );
      await expect(
        migrate(opened.executor, await loadCore(), { holder: 'edge-index-test' }),
      ).rejects.toThrow(/project_package.package_id.*1/);
      expect(await rows('SELECT package_id FROM project_package')).toEqual([
        { package_id: kind === 'missing' ? 'missing' : PACKAGE },
      ]);
      expect((await columns('project_package')).map((c) => c.name)).not.toContain('ecosystem');
      expect(await rows('SELECT id FROM schema_migration WHERE id = ?', [migrationId])).toEqual([]);
    },
  );

  it('skips 0024 on rerun and its index statements are schema no-ops', async () => {
    const sources = await loadCore();
    await migrate(opened.executor, sources, { holder: 'edge-index-test' });
    const result = await migrate(opened.executor, sources, { holder: 'edge-index-test' });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain(migrationId);
    const before = await rows('PRAGMA schema_version');
    const source = sources.find((s) => s.id === migrationId)!;
    for (const statement of source.sql
      .split(';')
      .filter((s) => /CREATE INDEX IF NOT EXISTS/i.test(s)))
      await run(statement);
    expect(await rows('PRAGMA schema_version')).toEqual(before);
  });
});
