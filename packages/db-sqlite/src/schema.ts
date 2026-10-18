import type { Generated } from 'kysely';
import type { VersionStability } from '@package-broker/core/catalogue/versions';
import type { VersionStatus } from '@package-broker/core/catalogue/version-rules';

export type { VersionStability, VersionStatus };

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

/** Mirrors `blob` in `migrations/0001_init.sql`, `migrations/0006_ports.sql` and `migrations/0009_upstream_state_content_index.sql`. */
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
  published_at: string | null;
}

export type Ecosystem = 'composer' | 'npm';
export type SourceType =
  'vcs' | 'composer_repository' | 'npm_registry' | 'packagist_proxy' | 'npmjs_proxy' | 'hosted';
export type ProtocolMode = 'v2' | 'v1-providers' | 'v1-lazy' | 'v1-includes' | 'npm-packument';
export type RemovalPolicy = 'flag' | 'exclude';
export type SourceStatus = 'active' | 'degraded' | 'failing' | 'paused';
export type PackageStatus = 'active' | 'removed_upstream';
export type ProjectPackageOrigin = 'subscription' | 'explicit' | 'pattern';
export type PatternEffect = 'include' | 'exclude';
export type DistType = 'zip' | 'tar' | 'tgz';
export type DistTagAction = 'set' | 'remove';

/** Mirrors `source` in `migrations/0001_init.sql`. */
export interface SourceTable {
  id: string;
  org_id: string;
  project_id: string | null;
  name: string;
  ecosystem: Ecosystem;
  type: SourceType;
  url: string | null;
  credential_id: string | null;
  config_json: Generated<string>;
  protocol_mode: ProtocolMode | null;
  has_available_packages: Generated<number>;
  user_agent: string | null;
  default_visible_to_new_projects: Generated<number>;
  removal_policy: Generated<RemovalPolicy>;
  retention_days_override: number | null;
  status: Generated<SourceStatus>;
  poll_interval_seconds: Generated<number>;
  next_poll_at: string | null;
  last_polled_at: string | null;
  last_success_at: string | null;
  poll_etag: string | null;
  poll_last_modified: string | null;
  root_hash: string | null;
  listing_hash: string | null;
  consecutive_failures: Generated<number>;
  last_error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `registered_name` in `migrations/0001_init.sql`. */
export interface RegisteredNameTable {
  id: string;
  org_id: string;
  source_id: string;
  ecosystem: Ecosystem;
  pattern: string;
  created_at: Generated<string>;
}

/** Mirrors `package` in `migrations/0001_init.sql`. */
export interface PackageTable {
  id: string;
  org_id: string;
  source_id: string;
  ecosystem: Ecosystem;
  name: string;
  description: string | null;
  visible_to_new_projects: Generated<number>;
  status: Generated<PackageStatus>;
  removed_upstream_at: string | null;
  rev: Generated<number>;
  modified_at: Generated<string>;
  last_synced_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `project_source` in `migrations/0001_init.sql`. */
export interface ProjectSourceTable {
  org_id: string;
  project_id: string;
  source_id: string;
  precedence: Generated<number>;
  created_at: Generated<string>;
}

/** Mirrors `project_package` in `migrations/0001_init.sql`. */
export interface ProjectPackageTable {
  org_id: string;
  project_id: string;
  package_id: string;
  origin: ProjectPackageOrigin;
  created_at: Generated<string>;
}

/** Mirrors `project_package_pattern` in `migrations/0001_init.sql`. */
export interface ProjectPackagePatternTable {
  id: string;
  org_id: string;
  project_id: string;
  source_id: string;
  pattern: string;
  effect: PatternEffect;
  created_at: Generated<string>;
}

/** Mirrors `version` in `migrations/0001_init.sql`. */
export interface VersionTable {
  id: string;
  org_id: string;
  package_id: string;
  version: string;
  version_normalized: string;
  stability: Generated<VersionStability>;
  published_at: string;
  published_at_basis: string;
  upstream_released_at: string | null;
  license: string | null;
  blob_id: string | null;
  dist_type: DistType | null;
  composer_shasum: string | null;
  npm_integrity: string | null;
  source_ref: string | null;
  metadata_json: string;
  deprecated_message: string | null;
  status: Generated<VersionStatus>;
  removed_upstream_at: string | null;
  tombstoned_at: string | null;
  tombstone_reason: string | null;
  purge_after: string | null;
  revision: Generated<number>;
  last_op_id: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `version_revision` in `migrations/0001_init.sql`. */
export interface VersionRevisionTable {
  id: string;
  org_id: string;
  version_id: string;
  revision: number;
  blob_id: string | null;
  source_ref: string | null;
  metadata_json: string;
  reason: string;
  op_id: string | null;
  created_at: Generated<string>;
}

/** Mirrors `dist_tag` in `migrations/0001_init.sql`. */
export interface DistTagTable {
  org_id: string;
  package_id: string;
  tag: string;
  version_id: string;
  updated_at: Generated<string>;
}

/** Mirrors `dist_tag_history` in `migrations/0001_init.sql`. */
export interface DistTagHistoryTable {
  id: string;
  org_id: string;
  package_id: string;
  tag: string;
  version_id: string | null;
  previous_version_id: string | null;
  action: DistTagAction;
  actor_type: string;
  actor_id: string | null;
  op_id: string | null;
  created_at: Generated<string>;
}

export type IngestScope = 'source' | 'package';
export type IngestState = 'running' | 'complete' | 'abandoned';
export type UpstreamForm =
  'composer-p2' | 'composer-p2-dev' | 'composer-v1-provider' | 'npm-packument';
export type RepresentationForm = 'composer-p2' | 'composer-p2-dev';

/** Mirrors `ingest_session` in `migrations/0007_registry.sql`. */
export interface IngestSessionTable {
  id: string;
  org_id: string;
  scope: IngestScope;
  scope_key: string;
  source_id: string;
  package_key: string | null;
  generation: number;
  owner: string;
  fence: number;
  lease_until: string;
  state: IngestState;
  snapshot_id: string | null;
  snapshot_blob_sha256: string | null;
  stamp: string | null;
  cursor: string | null;
  seen_count: Generated<number>;
  pending_validators: string | null;
  pages_so_far: Generated<number>;
  started_at: string;
  updated_at: string;
}

/** Mirrors `upstream_state` in `migrations/0007_registry.sql`. */
export interface UpstreamStateTable {
  org_id: string;
  package_id: string;
  form: UpstreamForm;
  etag: string | null;
  last_modified: string | null;
  content_sha256: string | null;
  checked_at: string;
  fresh_until: string;
  not_found_count: Generated<number>;
  first_not_found_at: string | null;
}

/** Mirrors `fetch_lease` in `migrations/0007_registry.sql`. */
export interface FetchLeaseTable {
  org_id: string;
  lease_key: string;
  owner: string;
  fence: number;
  lease_until: string;
  acquired_at: string;
}

/** Mirrors `representation_clock`. */
export interface RepresentationClockTable {
  org_id: string;
  project_id: string;
  key_hash: string;
  form: RepresentationForm;
  validator: string;
  last_modified: string;
  rev: Generated<number>;
  package_id: Generated<string>;
}

/** Mirrors `import_run` in `migrations/0001_init.sql` and `migrations/0012_import.sql`. */
export interface ImportRunTable {
  id: string;
  org_id: string;
  source_system: string;
  state: Generated<
    | 'planned'
    | 'applying'
    | 'failed'
    | 'applied'
    | 'verifying'
    | 'verified'
    | 'rolled_back'
    | 'cancelled'
  >;
  plan_hash: string | null;
  planned_count: Generated<number>;
  applied_count: Generated<number>;
  started_by_user_id: string | null;
  started_by_service_principal_id: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  credential_window_until: string | null;
  manifest_blob_sha256: string | null;
  before_image_expires_at: string | null;
  accepted_at: string | null;
  last_error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Mirrors `import_ref` in `migrations/0001_init.sql` and `migrations/0012_import.sql`. */
export interface ImportRefTable {
  id: string;
  org_id: string;
  import_run_id: string;
  entity_type: string;
  entity_id: string;
  external_ref: string;
  action: 'create' | 'update';
  before_image_json: string | null;
  content_hash: string | null;
  conflict_state: Generated<'none' | 'changed_after_import' | 'resolved'>;
  published_at_basis: 'source_release' | 'packagist_added' | 'import_time' | null;
  rolled_back_at: string | null;
  created_at: Generated<string>;
}

/** Mirrors `audit_pending` in `migrations/0011_api_audit.sql`. */
export interface AuditPendingTable {
  id: string;
  org_id: string;
  created_at: string;
  actor_type: 'user' | 'service_principal' | 'customer' | 'system';
  actor_id: string | null;
  token_selector: string | null;
  source_ip: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  project_id: string | null;
  payload_json: Generated<string>;
}

/** Mirrors `api_idempotency` in `migrations/0011_api_audit.sql`. */
export interface ApiIdempotencyTable {
  org_id: string;
  principal_key: string;
  key: string;
  route: string;
  request_hash: string;
  status: number;
  response_json: string;
  created_at: string;
  expires_at: string;
}

export interface Database {
  audit_pending: AuditPendingTable;
  api_idempotency: ApiIdempotencyTable;
  import_run: ImportRunTable;
  import_ref: ImportRefTable;
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
  source: SourceTable;
  registered_name: RegisteredNameTable;
  package: PackageTable;
  project_source: ProjectSourceTable;
  project_package: ProjectPackageTable;
  project_package_pattern: ProjectPackagePatternTable;
  version: VersionTable;
  version_revision: VersionRevisionTable;
  dist_tag: DistTagTable;
  dist_tag_history: DistTagHistoryTable;
  ingest_session: IngestSessionTable;
  upstream_state: UpstreamStateTable;
  fetch_lease: FetchLeaseTable;
  representation_clock: RepresentationClockTable;
}
