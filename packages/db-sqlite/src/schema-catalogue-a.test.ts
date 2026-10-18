import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { Insertable, Selectable } from 'kysely';
import { openNodeSqliteExecutor, type OpenedExecutor } from './testing/node-sqlite-executor.js';
import { migrate } from './migrations/runner.js';
import { loadMigrationSource } from './migrations/source.js';
import type {
  Database,
  PackageTable,
  ProjectPackagePatternTable,
  ProjectPackageTable,
  ProjectSourceTable,
  RegisteredNameTable,
  SourceTable,
} from './schema.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);

type CatalogueTable =
  | 'source'
  | 'registered_name'
  | 'package'
  | 'project_source'
  | 'project_package'
  | 'project_package_pattern';

type ExpectedNotNull<T extends CatalogueTable> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};

const declared: { [T in CatalogueTable]: ExpectedNotNull<T> } = {
  source: {
    id: 1,
    org_id: 1,
    project_id: 0,
    name: 1,
    ecosystem: 1,
    type: 1,
    url: 0,
    credential_id: 0,
    config_json: 1,
    protocol_mode: 0,
    has_available_packages: 1,
    user_agent: 0,
    default_visible_to_new_projects: 1,
    removal_policy: 1,
    retention_days_override: 0,
    status: 1,
    poll_interval_seconds: 1,
    next_poll_at: 0,
    last_polled_at: 0,
    last_success_at: 0,
    poll_etag: 0,
    poll_last_modified: 0,
    root_hash: 0,
    listing_hash: 0,
    listing_open_stamp: 0,
    listing_opened_at: 0,
    consecutive_failures: 1,
    last_error: 0,
    created_at: 1,
    updated_at: 1,
  },
  registered_name: { id: 1, org_id: 1, source_id: 1, ecosystem: 1, pattern: 1, created_at: 1 },
  package: {
    id: 1,
    org_id: 1,
    source_id: 1,
    ecosystem: 1,
    name: 1,
    description: 0,
    visible_to_new_projects: 1,
    status: 1,
    removed_upstream_at: 0,
    removal_cause: 0,
    last_op_id: 0,
    listing_open_stamp: 0,
    listing_opened_at: 0,
    listing_seen_stamp: 0,
    rev: 1,
    modified_at: 1,
    last_synced_at: 0,
    created_at: 1,
    updated_at: 1,
  },
  project_source: { org_id: 1, project_id: 1, source_id: 1, precedence: 1, created_at: 1 },
  project_package: { org_id: 1, project_id: 1, package_id: 1, origin: 1, created_at: 1 },
  project_package_pattern: {
    id: 1,
    org_id: 1,
    project_id: 1,
    source_id: 1,
    pattern: 1,
    effect: 1,
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
  await migrate(opened.executor, sources, { holder: 'schema-catalogue-a-test' });
});

afterAll(async () => {
  await opened.close();
});

describe('catalogue table types match the migrated database', () => {
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
});

describe('catalogue enumerations are literal unions', () => {
  it('ecosystem', () => {
    expectTypeOf<SourceTable['ecosystem']>().toEqualTypeOf<'composer' | 'npm'>();
    expectTypeOf<RegisteredNameTable['ecosystem']>().toEqualTypeOf<'composer' | 'npm'>();
    expectTypeOf<PackageTable['ecosystem']>().toEqualTypeOf<'composer' | 'npm'>();
  });

  it('source enumerations', () => {
    expectTypeOf<SourceTable['type']>().toEqualTypeOf<
      'vcs' | 'composer_repository' | 'npm_registry' | 'packagist_proxy' | 'npmjs_proxy' | 'hosted'
    >();
    expectTypeOf<SourceTable['protocol_mode']>().toEqualTypeOf<
      'v2' | 'v1-providers' | 'v1-lazy' | 'v1-includes' | 'npm-packument' | null
    >();
    expectTypeOf<Selectable<SourceTable>['removal_policy']>().toEqualTypeOf<'flag' | 'exclude'>();
    expectTypeOf<Selectable<SourceTable>['status']>().toEqualTypeOf<
      'active' | 'degraded' | 'failing' | 'paused'
    >();
  });

  it('package, project_package and pattern enumerations', () => {
    expectTypeOf<Selectable<PackageTable>['status']>().toEqualTypeOf<
      'active' | 'removed_upstream'
    >();
    expectTypeOf<ProjectPackageTable['origin']>().toEqualTypeOf<
      'subscription' | 'explicit' | 'pattern'
    >();
    expectTypeOf<ProjectPackagePatternTable['effect']>().toEqualTypeOf<'include' | 'exclude'>();
  });

  it('rejects values outside an enumeration', () => {
    // @ts-expect-error not a source status
    const status: Insertable<SourceTable>['status'] = 'broken';
    // @ts-expect-error not an origin
    const origin: ProjectPackageTable['origin'] = 'manual';
    expect([status, origin]).toHaveLength(2);
  });

  it('defaulted columns are optional on insert', () => {
    expectTypeOf<Insertable<ProjectSourceTable>>()
      .toHaveProperty('precedence')
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<Insertable<PackageTable>>()
      .toHaveProperty('rev')
      .toEqualTypeOf<number | undefined>();
  });
});
