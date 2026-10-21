import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { Insertable, Selectable } from 'kysely';
import { openNodeSqliteExecutor, type OpenedExecutor } from './testing/node-sqlite-executor.js';
import { migrate } from './migrations/runner.js';
import { loadMigrationSource } from './migrations/source.js';
import type {
  Database,
  FetchLeaseTable,
  IngestSessionTable,
  RepresentationClockTable,
  UpstreamStateTable,
} from './schema.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);

type RegistryTableName =
  'ingest_session' | 'upstream_state' | 'fetch_lease' | 'representation_clock';

type ExpectedNotNull<T extends RegistryTableName> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};

const declared: { [T in RegistryTableName]: ExpectedNotNull<T> } = {
  ingest_session: {
    id: 1,
    org_id: 1,
    scope: 1,
    scope_key: 1,
    source_id: 1,
    package_key: 0,
    generation: 1,
    owner: 1,
    fence: 1,
    lease_until: 1,
    state: 1,
    snapshot_id: 0,
    snapshot_blob_sha256: 0,
    stamp: 0,
    cursor: 0,
    seen_count: 1,
    pending_validators: 0,
    pages_so_far: 1,
    started_at: 1,
    updated_at: 1,
  },
  upstream_state: {
    org_id: 1,
    package_id: 1,
    form: 1,
    etag: 0,
    last_modified: 0,
    content_sha256: 0,
    checked_at: 1,
    fresh_until: 1,
    not_found_count: 1,
    first_not_found_at: 0,
  },
  fetch_lease: {
    org_id: 1,
    lease_key: 1,
    owner: 1,
    fence: 1,
    lease_until: 1,
    acquired_at: 1,
  },
  representation_clock: {
    org_id: 1,
    project_id: 1,
    key_hash: 1,
    form: 1,
    validator: 1,
    last_modified: 1,
    rev: 1,
    package_id: 1,
  },
};

let opened: OpenedExecutor;

beforeAll(async () => {
  opened = openNodeSqliteExecutor();
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sources = await Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
  await migrate(opened.executor, sources, { holder: 'schema-registry-test' });
});

afterAll(async () => {
  await opened.close();
});

describe('registry table types match the migrated database', () => {
  it('indexes version statuses by package', async () => {
    const columns = await opened.executor.all<{ name: string }>({
      sql: "SELECT name FROM pragma_index_info('version_package_status') ORDER BY seqno",
      params: [],
    });
    expect(columns.map((column) => column.name)).toEqual(['package_id', 'status']);
  });

  for (const [table, expected] of Object.entries(declared)) {
    it(`${table}: declared columns and NOT NULL equal PRAGMA table_info`, async () => {
      const found = await opened.executor.all<{ name: string; notnull: number }>({
        sql: `SELECT name, "notnull" FROM pragma_table_info('${table}') ORDER BY name`,
        params: [],
      });
      const actual = Object.fromEntries(found.map((column) => [column.name, column.notnull]));
      expect(actual).toEqual(expected);
    });
  }

  it('indexes upstream content hashes within an organization', async () => {
    const columns = await opened.executor.all<{ name: string }>({
      sql: "SELECT name FROM pragma_index_info('upstream_state_content') ORDER BY seqno",
      params: [],
    });
    expect(columns.map((column) => column.name)).toEqual(['org_id', 'content_sha256']);
  });

  it('indexes ingest snapshot hashes within an organization', async () => {
    const columns = await opened.executor.all<{ name: string }>({
      sql: "SELECT name FROM pragma_index_info('ingest_session_snapshot_blob') ORDER BY seqno",
      params: [],
    });
    expect(columns.map((column) => column.name)).toEqual(['org_id', 'snapshot_blob_sha256']);
  });

  it('backfills publication time from created_at when upgrading existing blobs', async () => {
    const upgrade = openNodeSqliteExecutor();
    try {
      const names = readdirSync(migrationsUrl)
        .filter((name) => name.endsWith('.sql'))
        .sort();
      const sources = await Promise.all(
        names.map((name) =>
          loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
        ),
      );
      await migrate(
        upgrade.executor,
        sources.filter((source) => source.id < 'core:0009_'),
        { holder: 'backfill-test' },
      );
      await upgrade.executor.batch([
        {
          sql: "INSERT INTO organization (id, slug, name) VALUES ('ORG', 'org', 'Org')",
          params: [],
        },
        {
          sql: "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, created_at) VALUES ('B', 'ORG', ?, 1, 'k', '2000-01-01T00:00:00.000Z')",
          params: ['a'.repeat(64)],
        },
      ]);
      await migrate(upgrade.executor, sources, { holder: 'backfill-test' });
      const rows = await upgrade.executor.all<{ published_at: string }>({
        sql: 'SELECT published_at FROM blob',
        params: [],
      });
      expect(rows).toEqual([{ published_at: '2000-01-01T00:00:00.000Z' }]);
    } finally {
      await upgrade.close();
    }
  });

  it('adds nullable publication time for blob inserts outside publish', async () => {
    const columns = await opened.executor.all<{ type: string; notnull: number }>({
      sql: `SELECT type, "notnull" FROM pragma_table_info('blob') WHERE name = 'published_at'`,
      params: [],
    });
    expect(columns).toEqual([{ type: 'TEXT', notnull: 0 }]);
  });

  it('column counts', () => {
    expect(Object.keys(declared.ingest_session)).toHaveLength(20);
    expect(Object.keys(declared.upstream_state)).toHaveLength(10);
    expect(Object.keys(declared.fetch_lease)).toHaveLength(6);
    expect(Object.keys(declared.representation_clock)).toHaveLength(8);
  });
});

describe('registry table types', () => {
  it('are registered on Database', () => {
    expectTypeOf<Database['ingest_session']>().toEqualTypeOf<IngestSessionTable>();
    expectTypeOf<Database['upstream_state']>().toEqualTypeOf<UpstreamStateTable>();
    expectTypeOf<Database['fetch_lease']>().toEqualTypeOf<FetchLeaseTable>();
    expectTypeOf<Database['representation_clock']>().toEqualTypeOf<RepresentationClockTable>();
  });

  it('enumerations are literal unions', () => {
    expectTypeOf<IngestSessionTable['scope']>().toEqualTypeOf<'source' | 'package'>();
    expectTypeOf<IngestSessionTable['state']>().toEqualTypeOf<
      'running' | 'complete' | 'abandoned'
    >();
    expectTypeOf<UpstreamStateTable['form']>().toEqualTypeOf<
      'composer-p2' | 'composer-p2-dev' | 'composer-v1-provider' | 'npm-packument'
    >();
    expectTypeOf<RepresentationClockTable['form']>().toEqualTypeOf<
      'composer-p2' | 'composer-p2-dev'
    >();
  });

  it('nullability and defaults', () => {
    expectTypeOf<IngestSessionTable['package_key']>().toEqualTypeOf<string | null>();
    expectTypeOf<IngestSessionTable['pending_validators']>().toEqualTypeOf<string | null>();
    expectTypeOf<Insertable<IngestSessionTable>>()
      .toHaveProperty('seen_count')
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<Insertable<IngestSessionTable>>()
      .toHaveProperty('pages_so_far')
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<Insertable<UpstreamStateTable>>()
      .toHaveProperty('not_found_count')
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<Insertable<IngestSessionTable>['generation']>().toEqualTypeOf<number>();
    expectTypeOf<Insertable<FetchLeaseTable>['fence']>().toEqualTypeOf<number>();
  });

  it('rejects misspelled columns and values outside an enumeration', () => {
    // @ts-expect-error misspelled column
    const column: keyof IngestSessionTable = 'lease_untill';
    // @ts-expect-error not an ingest state
    const state: IngestSessionTable['state'] = 'done';
    // @ts-expect-error not a representation form
    const form: RepresentationClockTable['form'] = 'npm-packument';
    expect([column, state, form]).toHaveLength(3);
  });
});
