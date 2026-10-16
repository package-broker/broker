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
  revision: Generated<number>;
  last_op_id: string | null;
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
  revision: Generated<number>;
  last_op_id: string | null;
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
  revision: Generated<number>;
  last_op_id: string | null;
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

/** Mirrors `service_principal` in `migrations/0001_init.sql` and `migrations/0003_access_model.sql`. */
export interface ServicePrincipalTable {
  id: string;
  org_id: string;
  name: string;
  project_id: string | null;
  created_by_user_id: string;
  status: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  revision: Generated<number>;
  last_op_id: string | null;
}

/** Mirrors `token` in `migrations/0001_init.sql` and `migrations/0003_access_model.sql`. */
export interface TokenTable {
  id: string;
  org_id: string;
  kind: string;
  selector: string;
  hash: string;
  pepper_version: number;
  name: string;
  scopes_json: string;
  read_only: Generated<number>;
  user_id: string | null;
  service_principal_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  created_by_user_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: Generated<string>;
  project_mode: string;
  validation_kind: string | null;
  validation_identity_id: string | null;
  last_op_id: string | null;
}

/** Mirrors `service_principal_permission` in `migrations/0003_access_model.sql`. */
export interface ServicePrincipalPermissionTable {
  org_id: string;
  service_principal_id: string;
  permission: string;
}

/** Mirrors `identity_block` in `migrations/0003_access_model.sql`. */
export interface IdentityBlockTable {
  org_id: string;
  provider: string;
  issuer: string;
  subject: string;
  blocked_at: Generated<string>;
  blocked_by_user_id: string | null;
}

/** Mirrors `access_mutation_guard` in `migrations/0003_access_model.sql`. */
export interface AccessMutationGuardTable {
  key: string;
}

/** Mirrors `cache_epoch` in `migrations/0004_cache_epoch.sql`. */
export interface CacheEpochTable {
  org_id: string;
  version: string;
}

/** Mirrors `job` in `migrations/0001_init.sql` and `migrations/0006_ports.sql`. */
export interface JobTable {
  id: string;
  org_id: string;
  type: string;
  payload_json: Generated<string>;
  resource_key: string | null;
  idempotency_key: string | null;
  state: Generated<string>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  lease_owner: string | null;
  lease_until: string | null;
  fence: Generated<number>;
  run_at: Generated<string>;
  last_error: string | null;
  finished_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  project_id: string | null;
  initiator_token_id: string | null;
}

/** Mirrors `job_attempt` in `migrations/0006_ports.sql`. */
export interface JobAttemptTable {
  id: string;
  org_id: string;
  job_id: string;
  attempt: number;
  fence: number;
  worker: string;
  outcome: Generated<string>;
  error: string | null;
  started_at: Generated<string>;
  finished_at: string | null;
  next_run_at: string | null;
}

/** Mirrors `job_schedule` in `migrations/0001_init.sql`. */
export interface JobScheduleTable {
  org_id: string;
  name: string;
  every_seconds: number | null;
  cron: string | null;
  next_run_at: string;
  last_slot: string | null;
  enabled: Generated<number>;
}

/** Mirrors `blob` in `migrations/0001_init.sql` and `migrations/0006_ports.sql`. */
export interface BlobTable {
  id: string;
  org_id: string;
  sha256: string;
  size_bytes: number;
  storage_key: string;
  media_type: Generated<string>;
  refetchable: Generated<number>;
  upstream_url: string | null;
  last_fetched_at: string | null;
  last_accessed_at: string | null;
  purge_after: string | null;
  deleted_at: string | null;
  created_at: Generated<string>;
  purge_generation: string | null;
  purge_lease_until: string | null;
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
  service_principal: ServicePrincipalTable;
  token: TokenTable;
  service_principal_permission: ServicePrincipalPermissionTable;
  identity_block: IdentityBlockTable;
  access_mutation_guard: AccessMutationGuardTable;
  cache_epoch: CacheEpochTable;
  job: JobTable;
  job_attempt: JobAttemptTable;
  job_schedule: JobScheduleTable;
  blob: BlobTable;
}
