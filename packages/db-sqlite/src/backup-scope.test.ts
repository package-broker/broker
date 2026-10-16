import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_SCOPE, backupScopeOf } from './backup-scope.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

let database: MigratedDatabase;

beforeEach(async () => {
  database = await openMigratedDatabase();
});

afterEach(async () => {
  await database.close();
});

async function migratedTables(): Promise<string[]> {
  const found = await database.executor.all<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    params: [],
  });
  return found.map((row) => row.name);
}

describe('backup scope manifest', () => {
  it('classifies every migrated table and lists nothing else', async () => {
    expect(Object.keys(BACKUP_SCOPE).sort()).toEqual(await migratedTables());
  });

  it('regenerates cache_epoch and keeps only the rows of blob', () => {
    expect(backupScopeOf('cache_epoch')).toBe('regenerate');
    expect(backupScopeOf('blob')).toBe('include-rows-only');
  });

  it.each([
    'session',
    'user_group',
    'job',
    'job_attempt',
    'job_schedule',
    'webhook_delivery',
    'migration_lock',
    'access_mutation_guard',
    'ingest_session',
    'upstream_state',
    'fetch_lease',
    'representation_clock',
  ])('excludes %s', (table) => {
    expect(backupScopeOf(table)).toBe('exclude');
  });

  it('matches the specified manifest exactly', () => {
    expect(BACKUP_SCOPE).toEqual({
      organization: 'include',
      user_account: 'include',
      identity: 'include',
      role: 'include',
      role_permission: 'include',
      access_grant: 'include',
      project: 'include',
      service_principal: 'include',
      service_principal_permission: 'include',
      token: 'include',
      token_project: 'include',
      credential: 'include',
      source: 'include',
      registered_name: 'include',
      project_source: 'include',
      project_package: 'include',
      project_package_pattern: 'include',
      package: 'include',
      version: 'include',
      version_revision: 'include',
      dist_tag: 'include',
      dist_tag_history: 'include',
      customer: 'include',
      customer_grant: 'include',
      bundle: 'include',
      bundle_item: 'include',
      audit_event: 'include',
      import_run: 'include',
      import_ref: 'include',
      schema_migration: 'include',
      identity_block: 'include',
      local_login: 'include',
      identity_provider_binding: 'include',
      blob: 'include-rows-only',
      cache_epoch: 'regenerate',
      session: 'exclude',
      user_group: 'exclude',
      job: 'exclude',
      job_attempt: 'exclude',
      job_schedule: 'exclude',
      webhook_delivery: 'exclude',
      migration_lock: 'exclude',
      access_mutation_guard: 'exclude',
      ingest_session: 'exclude',
      upstream_state: 'exclude',
      fetch_lease: 'exclude',
      representation_clock: 'exclude',
    });
  });

  it('rejects a table that is not classified', () => {
    expect(() => backupScopeOf('no_such_table')).toThrow('no_such_table');
  });
});
