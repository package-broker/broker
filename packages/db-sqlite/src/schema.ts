import type { Generated } from 'kysely';

/** Mirrors `organization` in `migrations/0001_init.sql`. */
export interface OrganizationTable {
  id: string;
  singleton: Generated<number>;
  slug: string;
  name: string;
  retention_removed_upstream_days: Generated<number>;
  token_default_expiry_days: Generated<number>;
  token_ci_readonly_expiry_days: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `schema_migration` in `migrations/0001_init.sql`. */
export interface SchemaMigrationTable {
  id: string;
  name: string;
  checksum: string;
  applied_at: Generated<string>;
}

/** Mirrors `migration_lock` in `migrations/0001_init.sql`. */
export interface MigrationLockTable {
  id: number;
  holder: string | null;
  acquired_at: string | null;
  expires_at: string | null;
}

export interface Database {
  organization: OrganizationTable;
  schema_migration: SchemaMigrationTable;
  migration_lock: MigrationLockTable;
}
