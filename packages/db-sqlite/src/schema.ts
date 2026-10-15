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

/** Mirrors `user_account` in `migrations/0001_init.sql`. */
export interface UserAccountTable {
  id: string;
  org_id: string;
  email: string;
  display_name: string | null;
  status: Generated<string>;
  last_login_at: string | null;
  idp_validated_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `identity` in `migrations/0001_init.sql` and `migrations/0002_local_login.sql`. */
export interface IdentityTable {
  id: string;
  org_id: string;
  user_id: string;
  provider: string;
  subject: string;
  email: string;
  email_verified: Generated<number>;
  validated_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `user_group` in `migrations/0001_init.sql`. */
export interface UserGroupTable {
  org_id: string;
  user_id: string;
  provider: string;
  group_name: string;
  refreshed_at: Generated<string>;
}

/** Mirrors `session` in `migrations/0001_init.sql`. */
export interface SessionTable {
  id: string;
  org_id: string;
  user_id: string;
  identity_id: string | null;
  secret_hash: string;
  csrf_hash: string;
  created_at: Generated<string>;
  expires_at: string;
  last_seen_at: string | null;
  reauth_at: string | null;
  revoked_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

/** Mirrors `role` in `migrations/0001_init.sql`. */
export interface RoleTable {
  id: string;
  org_id: string;
  key: string;
  name: string;
  scope: string;
  is_system: Generated<number>;
  protects_last_holder: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `role_permission` in `migrations/0001_init.sql`. */
export interface RolePermissionTable {
  org_id: string;
  role_id: string;
  permission: string;
}

/** Mirrors `access_grant` in `migrations/0001_init.sql`. */
export interface AccessGrantTable {
  id: string;
  org_id: string;
  subject_type: string;
  subject_value: string;
  subject_provider: string | null;
  scope: string;
  project_id: string | null;
  role_id: string;
  created_by: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `project` in `migrations/0001_init.sql`. */
export interface ProjectTable {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  status: Generated<string>;
  token_max_scope: Generated<string>;
  require_publish_approval: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `credential` in `migrations/0001_init.sql`. */
export interface CredentialTable {
  id: string;
  org_id: string;
  project_id: string | null;
  kind: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  key_version: number;
  aad: string;
  rotated_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `local_login` in `migrations/0002_local_login.sql`. */
export interface LocalLoginTable {
  user_id: string;
  org_id: string;
  password_hash: string | null;
  totp_credential_id: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | null;
  credential_rev: Generated<number>;
  setup_hash: string | null;
  setup_expires_at: string | null;
  failed_count: Generated<number>;
  locked_until: string | null;
  last_op_id: string | null;
  last_login_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `identity_provider_binding` in `migrations/0002_local_login.sql`. */
export interface IdentityProviderBindingTable {
  org_id: string;
  provider: string;
  anchor: string;
  created_at: Generated<string>;
}

export interface Database {
  organization: OrganizationTable;
  schema_migration: SchemaMigrationTable;
  migration_lock: MigrationLockTable;
  user_account: UserAccountTable;
  identity: IdentityTable;
  user_group: UserGroupTable;
  session: SessionTable;
  role: RoleTable;
  role_permission: RolePermissionTable;
  access_grant: AccessGrantTable;
  project: ProjectTable;
  credential: CredentialTable;
  local_login: LocalLoginTable;
  identity_provider_binding: IdentityProviderBindingTable;
}
