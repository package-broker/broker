import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { Insertable, Selectable } from 'kysely';
import { openNodeSqliteExecutor, type OpenedExecutor } from './testing/node-sqlite-executor.js';
import { migrate } from './migrations/runner.js';
import { loadMigrationSource } from './migrations/source.js';
import type { VersionStability as CoreStability } from '@package-broker/core/catalogue/versions';
import type { VersionStatus as CoreStatus } from '@package-broker/core/catalogue/version-rules';
import type {
  Database,
  DistTagHistoryTable,
  DistTagTable,
  VersionRevisionTable,
  VersionStability,
  VersionStatus,
  VersionTable,
} from './schema.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);

type VersionTableName = 'version' | 'version_revision' | 'dist_tag' | 'dist_tag_history';

type ExpectedNotNull<T extends VersionTableName> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};

const declared: { [T in VersionTableName]: ExpectedNotNull<T> } = {
  version: {
    listing_seen_stamp: 0,
    id: 1,
    org_id: 1,
    package_id: 1,
    version: 1,
    version_normalized: 1,
    stability: 1,
    published_at: 1,
    published_at_basis: 1,
    upstream_released_at: 0,
    license: 0,
    blob_id: 0,
    dist_type: 0,
    composer_shasum: 0,
    npm_integrity: 0,
    source_ref: 0,
    metadata_json: 1,
    deprecated_message: 0,
    status: 1,
    removed_upstream_at: 0,
    tombstoned_at: 0,
    tombstone_reason: 0,
    purge_after: 0,
    revision: 1,
    last_op_id: 0,
    created_at: 1,
    updated_at: 1,
  },
  version_revision: {
    id: 1,
    org_id: 1,
    version_id: 1,
    revision: 1,
    blob_id: 0,
    source_ref: 0,
    metadata_json: 1,
    reason: 1,
    op_id: 0,
    created_at: 1,
  },
  dist_tag: { org_id: 1, package_id: 1, tag: 1, version_id: 1, updated_at: 1 },
  dist_tag_history: {
    id: 1,
    org_id: 1,
    package_id: 1,
    tag: 1,
    version_id: 0,
    previous_version_id: 0,
    action: 1,
    actor_type: 1,
    actor_id: 0,
    op_id: 0,
    created_at: 1,
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
  await migrate(opened.executor, sources, { holder: 'schema-catalogue-b-test' });
});

afterAll(async () => {
  await opened.close();
});

describe('version table types match the migrated database', () => {
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

  it('version declares 27 columns', () => {
    expect(Object.keys(declared.version)).toHaveLength(27);
  });
});

describe('version enumerations are literal unions', () => {
  it('version enumerations', () => {
    expectTypeOf<Selectable<VersionTable>['stability']>().toEqualTypeOf<
      'dev' | 'alpha' | 'beta' | 'RC' | 'stable'
    >();
    expectTypeOf<Selectable<VersionTable>['status']>().toEqualTypeOf<
      'active' | 'removed_upstream' | 'yanked' | 'quarantined' | 'tombstoned'
    >();
    expectTypeOf<VersionTable['dist_type']>().toEqualTypeOf<'zip' | 'tar' | 'tgz' | null>();
  });

  it('dist_tag_history action', () => {
    expectTypeOf<DistTagHistoryTable['action']>().toEqualTypeOf<'set' | 'remove'>();
  });

  it('rejects values outside an enumeration', () => {
    // @ts-expect-error not a version status
    const status: Insertable<VersionTable>['status'] = 'deleted';
    // @ts-expect-error not a history action
    const action: DistTagHistoryTable['action'] = 'update';
    // @ts-expect-error not a stability
    const stability: Insertable<VersionTable>['stability'] = 'nightly';
    // @ts-expect-error not a dist type
    const distType: VersionTable['dist_type'] = 'rar';
    expect([status, action, stability, distType]).toHaveLength(4);
  });

  it('nullable digests and defaulted columns', () => {
    expectTypeOf<VersionTable['composer_shasum']>().toEqualTypeOf<string | null>();
    expectTypeOf<VersionTable['npm_integrity']>().toEqualTypeOf<string | null>();
    expectTypeOf<Insertable<VersionTable>>()
      .toHaveProperty('revision')
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<Insertable<VersionTable>>()
      .toHaveProperty('status')
      .toEqualTypeOf<
        'active' | 'removed_upstream' | 'yanked' | 'quarantined' | 'tombstoned' | undefined
      >();
    expectTypeOf<Insertable<DistTagTable>>()
      .toHaveProperty('updated_at')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<Insertable<VersionRevisionTable>>()
      .toHaveProperty('created_at')
      .toEqualTypeOf<string | undefined>();
  });

  it('required columns without a default are plain on insert', () => {
    expectTypeOf<Insertable<VersionTable>['version_normalized']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<VersionTable>['published_at']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<VersionTable>['published_at_basis']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<VersionTable>['metadata_json']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<VersionRevisionTable>['revision']>().toEqualTypeOf<number>();
    expectTypeOf<Insertable<VersionRevisionTable>['metadata_json']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<VersionRevisionTable>['reason']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<DistTagTable>['version_id']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<DistTagTable>['tag']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<DistTagHistoryTable>['action']>().toEqualTypeOf<'set' | 'remove'>();
    expectTypeOf<Insertable<DistTagHistoryTable>['actor_type']>().toEqualTypeOf<string>();
    expectTypeOf<Insertable<DistTagHistoryTable>['tag']>().toEqualTypeOf<string>();
  });

  it('shares the core unions', () => {
    expectTypeOf<VersionStability>().toEqualTypeOf<CoreStability>();
    expectTypeOf<VersionStatus>().toEqualTypeOf<CoreStatus>();
  });
});
