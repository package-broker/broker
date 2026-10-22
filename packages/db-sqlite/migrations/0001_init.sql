-- Package Broker 2.0, fresh baseline, migration 0001. SQLite dialect (Cloudflare D1, better-sqlite3, node:sqlite).
-- No BEGIN/COMMIT: the runner applies the file as one batch. No PRAGMA: D1 always enforces
-- foreign keys; better-sqlite3 and the sqlite3 CLI need PRAGMA foreign_keys = ON per connection.
-- Timestamps: ISO-8601 UTC text with milliseconds and a Z suffix (strftime('%Y-%m-%dT%H:%M:%fZ')).
-- Booleans: INTEGER 0/1 with CHECK. Keys: ULID text. org_id is a constant, see schema-notes.md.

-- ---------------------------------------------------------------------------
-- Migration, keyring and mutation guards
-- ---------------------------------------------------------------------------

CREATE TABLE access_mutation_guard (
  key TEXT NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64)
) STRICT;

CREATE TABLE keyring_verifier (
  key_version INTEGER NOT NULL PRIMARY KEY CHECK (key_version >= 1),
  mac         BLOB NOT NULL CHECK (length(mac) = 32),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE migration_lock (
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  holder      TEXT,
  acquired_at TEXT,
  expires_at  TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- Organization, projects, roles and users
-- ---------------------------------------------------------------------------

CREATE TABLE organization (
  id                              TEXT NOT NULL PRIMARY KEY,
  singleton                       INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1),
  slug                            TEXT NOT NULL CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 64),
  name                            TEXT NOT NULL,
  retention_removed_upstream_days INTEGER NOT NULL DEFAULT 365 CHECK (retention_removed_upstream_days >= 0),
  token_default_expiry_days       INTEGER NOT NULL DEFAULT 90 CHECK (token_default_expiry_days > 0),
  token_ci_readonly_expiry_days   INTEGER NOT NULL DEFAULT 365 CHECK (token_ci_readonly_expiry_days > 0),
  created_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE project (
  id                       TEXT NOT NULL PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organization (id),
  slug                     TEXT NOT NULL CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 64),
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  token_max_scope          TEXT NOT NULL DEFAULT 'full' CHECK (token_max_scope IN ('read', 'write', 'full')),
  require_publish_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_publish_approval IN (0, 1)),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revision                 INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_op_id               TEXT
) STRICT;

CREATE TABLE representation_clock (
  org_id        TEXT NOT NULL REFERENCES organization (id),
  project_id    TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash = lower(key_hash) AND key_hash NOT GLOB '*[^0-9a-f]*'),
  form          TEXT NOT NULL CHECK (form IN ('composer-p2', 'composer-p2-dev')),
  validator     TEXT NOT NULL CHECK (length(validator) = 64 AND validator = lower(validator) AND validator NOT GLOB '*[^0-9a-f]*'),
  last_modified TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  package_id    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, key_hash, form)
) STRICT, WITHOUT ROWID;

CREATE TABLE role (
  id                   TEXT NOT NULL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization (id),
  key                  TEXT NOT NULL CHECK (key = lower(key)),
  name                 TEXT NOT NULL,
  scope                TEXT NOT NULL CHECK (scope IN ('organization', 'project')),
  is_system            INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  protects_last_holder INTEGER NOT NULL DEFAULT 0 CHECK (protects_last_holder IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_op_id           TEXT
) STRICT;

CREATE TABLE role_permission (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  role_id    TEXT NOT NULL REFERENCES role (id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
) STRICT, WITHOUT ROWID;

CREATE TABLE schema_migration (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE user_account (
  id                 TEXT NOT NULL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organization (id),
  email              TEXT NOT NULL CHECK (email = lower(email)),
  display_name       TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  last_login_at      TEXT,
  idp_validated_at   TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pat_invalid_before TEXT
) STRICT;

CREATE TABLE user_group (
  org_id       TEXT NOT NULL REFERENCES organization (id),
  user_id      TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  group_name   TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, provider, group_name)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Advisory synchronization
-- ---------------------------------------------------------------------------

CREATE TABLE vulnerability_advisory (
  org_id          TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'osv' CHECK (source = 'osv'),
  advisory_id     TEXT NOT NULL CHECK (length(CAST(advisory_id AS BLOB)) BETWEEN 1 AND 200 AND instr(advisory_id, '/') = 0 AND instr(advisory_id, char(92)) = 0 AND advisory_id NOT IN ('.', '..')),
  detail_json     TEXT CHECK (detail_json IS NULL OR (length(CAST(detail_json AS BLOB)) <= 65536 AND json_valid(detail_json) AND json_type(detail_json) = 'object')),
  summary         TEXT CHECK (summary IS NULL OR length(CAST(summary AS BLOB)) <= 8192),
  severity_json   TEXT CHECK (severity_json IS NULL OR (length(CAST(severity_json AS BLOB)) <= 16384 AND json_valid(severity_json))),
  modified_at     TEXT CHECK (modified_at IS NULL OR (length(modified_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', modified_at) IS modified_at)),
  fetched_at      TEXT CHECK (fetched_at IS NULL OR (length(fetched_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at) IS fetched_at)),
  next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at),
  failure_count   INTEGER NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 1000),
  last_error_code TEXT CHECK (last_error_code IN ('unavailable', 'protocol', 'config', 'limit')),
  PRIMARY KEY (org_id, source, advisory_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE vulnerability_sync_state (
  org_id               TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source               TEXT NOT NULL DEFAULT 'osv' CHECK (source = 'osv'),
  fence                INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_owner          TEXT,
  lease_until          TEXT CHECK (lease_until IS NULL OR (length(lease_until) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) IS lease_until)),
  next_request_at      TEXT NOT NULL CHECK (length(next_request_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_request_at) IS next_request_at),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 1000),
  write_token          TEXT,
  prune_cursor         TEXT NOT NULL DEFAULT '',
  selection_cursor     TEXT NOT NULL DEFAULT '{"due":"","id":""}' CHECK (length(selection_cursor) <= 1024 AND json_valid(selection_cursor) AND json_type(selection_cursor) = 'object'),
  blocked_until        TEXT CHECK (blocked_until IS NULL OR (length(blocked_until) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', blocked_until) IS blocked_until)),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  PRIMARY KEY (org_id, source)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Access, audit, storage and identity
-- ---------------------------------------------------------------------------

CREATE TABLE access_grant (
  id               TEXT NOT NULL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organization (id),
  subject_type     TEXT NOT NULL CHECK (subject_type IN ('group', 'email')),
  subject_value    TEXT NOT NULL CHECK (subject_type = 'group' OR subject_value = lower(subject_value)),
  subject_provider TEXT CHECK ((subject_type = 'group' AND subject_provider IS NOT NULL AND length(subject_provider) BETWEEN 1 AND 64 AND subject_provider = trim(subject_provider)) OR (subject_type = 'email' AND subject_provider IS NULL)),
  scope            TEXT NOT NULL CHECK (scope IN ('organization', 'project')),
  project_id       TEXT REFERENCES project (id),
  role_id          TEXT NOT NULL REFERENCES role (id),
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_op_id       TEXT,
  CHECK ((scope = 'organization' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
) STRICT;

CREATE TABLE api_idempotency (
  org_id        TEXT NOT NULL REFERENCES organization (id),
  principal_key TEXT NOT NULL CHECK (length(principal_key) BETWEEN 1 AND 80),
  key           TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  route         TEXT NOT NULL,
  request_hash  TEXT NOT NULL CHECK (length(request_hash) = 64),
  status        INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, principal_key, key)
) STRICT;

CREATE TABLE audit_event (
  id             TEXT NOT NULL PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organization (id),
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  prev_hash      TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash           TEXT NOT NULL CHECK (length(hash) = 64),
  created_at     TEXT NOT NULL,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('user', 'service_principal', 'customer', 'system')),
  actor_id       TEXT,
  token_selector TEXT,
  source_ip      TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT,
  project_id     TEXT,
  payload_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json))
) STRICT;

CREATE TABLE audit_pending (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organization (id),
  created_at     TEXT NOT NULL,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('user', 'service_principal', 'customer', 'system')),
  actor_id       TEXT,
  token_selector TEXT,
  source_ip      TEXT,
  action         TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 64),
  target_type    TEXT NOT NULL,
  target_id      TEXT,
  project_id     TEXT,
  payload_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 4096)
) STRICT;

CREATE TABLE blob (
  id                TEXT NOT NULL PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organization (id),
  sha256            TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_key       TEXT NOT NULL,
  media_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
  refetchable       INTEGER NOT NULL DEFAULT 1 CHECK (refetchable IN (0, 1)),
  upstream_url      TEXT,
  last_fetched_at   TEXT,
  last_accessed_at  TEXT,
  purge_after       TEXT,
  deleted_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  purge_generation  TEXT,
  purge_lease_until TEXT,
  published_at      TEXT
) STRICT;

CREATE TABLE bundle (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  name       TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE cache_epoch (
  org_id  TEXT NOT NULL PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  version TEXT NOT NULL
) STRICT;

CREATE TABLE credential (
  id          TEXT NOT NULL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organization (id),
  project_id  TEXT REFERENCES project (id),
  kind        TEXT NOT NULL,
  ciphertext  BLOB NOT NULL,
  nonce       BLOB NOT NULL CHECK (length(nonce) = 12),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  aad         TEXT NOT NULL,
  rotated_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE customer (
  id           TEXT NOT NULL PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organization (id),
  name         TEXT NOT NULL,
  email        TEXT CHECK (email IS NULL OR email = lower(email)),
  external_ref TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE fetch_lease (
  org_id      TEXT NOT NULL REFERENCES organization (id),
  lease_key   TEXT NOT NULL PRIMARY KEY CHECK (length(lease_key) = 64 AND lease_key = lower(lease_key) AND lease_key NOT GLOB '*[^0-9a-f]*'),
  owner       TEXT NOT NULL,
  fence       INTEGER NOT NULL CHECK (fence >= 1),
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE identity (
  id             TEXT NOT NULL PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organization (id),
  user_id        TEXT NOT NULL REFERENCES user_account (id),
  provider       TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  subject        TEXT NOT NULL,
  email          TEXT NOT NULL CHECK (email = lower(email)),
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  validated_at   TEXT
) STRICT;

CREATE TABLE identity_block (
  org_id             TEXT NOT NULL REFERENCES organization (id),
  provider           TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  issuer             TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  subject            TEXT NOT NULL CHECK (length(subject) >= 1),
  blocked_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  blocked_by_user_id TEXT REFERENCES user_account (id),
  PRIMARY KEY (org_id, provider, issuer, subject)
) STRICT, WITHOUT ROWID;

CREATE TABLE identity_provider_binding (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  provider   TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  anchor     TEXT NOT NULL CHECK (length(anchor) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, provider)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Jobs, authentication and sources
-- ---------------------------------------------------------------------------

CREATE TABLE job (
  id                 TEXT NOT NULL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organization (id),
  type               TEXT NOT NULL,
  payload_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(payload_json) <= 131072),
  resource_key       TEXT,
  idempotency_key    TEXT,
  state              TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'dead')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  lease_owner        TEXT,
  lease_until        TEXT,
  fence              INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
  run_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_error         TEXT,
  finished_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  project_id         TEXT REFERENCES project (id),
  initiator_token_id TEXT,
  CHECK (state <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
) STRICT;

CREATE TABLE job_attempt (
  id          TEXT NOT NULL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organization (id),
  job_id      TEXT NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL CHECK (attempt >= 1),
  fence       INTEGER NOT NULL CHECK (fence >= 1),
  worker      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'succeeded', 'failed', 'lease_expired', 'released')),
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  next_run_at TEXT
) STRICT;

CREATE TABLE job_schedule (
  org_id        TEXT NOT NULL REFERENCES organization (id),
  name          TEXT NOT NULL,
  every_seconds INTEGER CHECK (every_seconds IS NULL OR every_seconds > 0),
  cron          TEXT,
  next_run_at   TEXT NOT NULL,
  last_slot     TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (org_id, name),
  CHECK (every_seconds IS NOT NULL OR cron IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE TABLE local_login (
  user_id            TEXT NOT NULL PRIMARY KEY REFERENCES user_account (id),
  org_id             TEXT NOT NULL REFERENCES organization (id),
  password_hash      TEXT CHECK (password_hash IS NULL OR password_hash GLOB 'pbkdf2-sha256$*'),
  totp_credential_id TEXT REFERENCES credential (id) ON DELETE SET NULL,
  totp_enabled_at    TEXT,
  totp_last_step     INTEGER CHECK (totp_last_step IS NULL OR totp_last_step >= 0),
  credential_rev     INTEGER NOT NULL DEFAULT 0 CHECK (credential_rev >= 0),
  setup_hash         TEXT CHECK (setup_hash IS NULL OR (length(setup_hash) = 64 AND setup_hash NOT GLOB '*[^0-9a-f]*')),
  setup_expires_at   TEXT,
  failed_count       INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until       TEXT,
  last_op_id         TEXT,
  last_login_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((setup_hash IS NULL) = (setup_expires_at IS NULL))
) STRICT;

CREATE TABLE service_principal (
  id                 TEXT NOT NULL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organization (id),
  name               TEXT NOT NULL,
  project_id         TEXT REFERENCES project (id),
  created_by_user_id TEXT NOT NULL REFERENCES user_account (id),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_op_id         TEXT
) STRICT;

CREATE TABLE service_principal_permission (
  org_id               TEXT NOT NULL REFERENCES organization (id),
  service_principal_id TEXT NOT NULL,
  permission           TEXT NOT NULL,
  PRIMARY KEY (org_id, service_principal_id, permission),
  FOREIGN KEY (org_id, service_principal_id) REFERENCES service_principal (org_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE session (
  id           TEXT NOT NULL PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organization (id),
  user_id      TEXT NOT NULL REFERENCES user_account (id),
  identity_id  TEXT REFERENCES identity (id),
  secret_hash  TEXT NOT NULL CHECK (length(secret_hash) = 64),
  csrf_hash    TEXT NOT NULL CHECK (length(csrf_hash) = 64),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  reauth_at    TEXT,
  revoked_at   TEXT,
  ip           TEXT,
  user_agent   TEXT
) STRICT;

CREATE TABLE source (
  id                              TEXT NOT NULL PRIMARY KEY,
  org_id                          TEXT NOT NULL REFERENCES organization (id),
  project_id                      TEXT REFERENCES project (id),
  name                            TEXT NOT NULL,
  ecosystem                       TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  type                            TEXT NOT NULL CHECK (type IN ('vcs', 'composer_repository', 'npm_registry', 'packagist_proxy', 'npmjs_proxy', 'hosted')),
  url                             TEXT,
  credential_id                   TEXT REFERENCES credential (id),
  config_json                     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  protocol_mode                   TEXT CHECK (protocol_mode IS NULL OR protocol_mode IN ('v2', 'v1-providers', 'v1-lazy', 'v1-includes', 'npm-packument')),
  has_available_packages          INTEGER NOT NULL DEFAULT 0 CHECK (has_available_packages IN (0, 1)),
  user_agent                      TEXT,
  default_visible_to_new_projects INTEGER NOT NULL DEFAULT 1 CHECK (default_visible_to_new_projects IN (0, 1)),
  removal_policy                  TEXT NOT NULL DEFAULT 'flag' CHECK (removal_policy IN ('flag', 'exclude')),
  retention_days_override         INTEGER CHECK (retention_days_override IS NULL OR retention_days_override >= 0),
  status                          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'failing', 'paused')),
  poll_interval_seconds           INTEGER NOT NULL DEFAULT 86400 CHECK (poll_interval_seconds > 0),
  next_poll_at                    TEXT,
  last_polled_at                  TEXT,
  last_success_at                 TEXT,
  poll_etag                       TEXT,
  poll_last_modified              TEXT,
  root_hash                       TEXT,
  listing_hash                    TEXT,
  consecutive_failures            INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error                      TEXT,
  created_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  listing_open_stamp              TEXT,
  listing_opened_at               TEXT
) STRICT;

CREATE TABLE token (
  id                     TEXT NOT NULL PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organization (id),
  kind                   TEXT NOT NULL CHECK (kind IN ('pat', 'svc', 'cst')),
  selector               TEXT NOT NULL CHECK (length(selector) = 12),
  hash                   TEXT NOT NULL CHECK (length(hash) = 64),
  pepper_version         INTEGER NOT NULL CHECK (pepper_version >= 1),
  name                   TEXT NOT NULL,
  scopes_json            TEXT NOT NULL CHECK (json_valid(scopes_json)),
  read_only              INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  user_id                TEXT REFERENCES user_account (id),
  service_principal_id   TEXT REFERENCES service_principal (id),
  customer_id            TEXT REFERENCES customer (id),
  project_id             TEXT REFERENCES project (id),
  created_by_user_id     TEXT REFERENCES user_account (id),
  expires_at             TEXT,
  revoked_at             TEXT,
  last_used_at           TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  project_mode           TEXT NOT NULL DEFAULT 'selected' CHECK (project_mode IN ('all', 'selected')),
  validation_kind        TEXT CHECK (validation_kind IS NULL OR (validation_kind IN ('sso', 'local') AND kind = 'pat')),
  validation_identity_id TEXT REFERENCES identity (id) ON DELETE SET NULL CHECK (validation_identity_id IS NULL OR (validation_kind IS NOT 'local' AND kind = 'pat')),
  last_op_id             TEXT,
  CHECK ( (kind = 'pat' AND user_id IS NOT NULL AND service_principal_id IS NULL AND customer_id IS NULL) OR (kind = 'svc' AND service_principal_id IS NOT NULL AND user_id IS NULL AND customer_id IS NULL) OR (kind = 'cst' AND customer_id IS NOT NULL AND user_id IS NULL AND service_principal_id IS NULL) ),
  CHECK (kind = 'cst' OR expires_at IS NOT NULL)
) STRICT;

CREATE TABLE token_project (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  token_id   TEXT NOT NULL REFERENCES token (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project (id),
  PRIMARY KEY (token_id, project_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE webhook_delivery (
  org_id       TEXT NOT NULL REFERENCES organization (id),
  provider     TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  source_id    TEXT REFERENCES source (id),
  event        TEXT NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'received' CHECK (outcome IN ('received', 'processed', 'ignored', 'failed')),
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  PRIMARY KEY (provider, delivery_id)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Import and ingest
-- ---------------------------------------------------------------------------

CREATE TABLE import_run (
  id                              TEXT NOT NULL PRIMARY KEY,
  org_id                          TEXT NOT NULL REFERENCES organization (id),
  source_system                   TEXT NOT NULL,
  state                           TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'applying', 'failed', 'applied', 'verifying', 'verified', 'rolled_back', 'cancelled')),
  plan_hash                       TEXT,
  planned_count                   INTEGER NOT NULL DEFAULT 0 CHECK (planned_count >= 0),
  applied_count                   INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  started_by_user_id              TEXT REFERENCES user_account (id),
  before_image_expires_at         TEXT,
  accepted_at                     TEXT,
  last_error                      TEXT,
  created_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_by_user_id             TEXT REFERENCES user_account (id),
  approved_at                     TEXT,
  credential_window_until         TEXT,
  started_by_service_principal_id TEXT REFERENCES service_principal (id),
  manifest_blob_sha256            TEXT CHECK (manifest_blob_sha256 IS NULL OR length(manifest_blob_sha256) = 64),
  rollback_restored_count         INTEGER NOT NULL DEFAULT 0 CHECK (rollback_restored_count >= 0),
  rollback_conflict_count         INTEGER NOT NULL DEFAULT 0 CHECK (rollback_conflict_count >= 0),
  rollback_expired_count          INTEGER NOT NULL DEFAULT 0 CHECK (rollback_expired_count >= 0)
) STRICT;

CREATE TABLE ingest_session (
  id                   TEXT NOT NULL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization (id),
  scope                TEXT NOT NULL CHECK (scope IN ('source', 'package')),
  scope_key            TEXT NOT NULL CHECK (length(scope_key) = 64 AND scope_key = lower(scope_key) AND scope_key NOT GLOB '*[^0-9a-f]*'),
  source_id            TEXT NOT NULL REFERENCES source (id) ON DELETE CASCADE,
  package_key          TEXT,
  generation           INTEGER NOT NULL CHECK (generation >= 1),
  owner                TEXT NOT NULL,
  fence                INTEGER NOT NULL CHECK (fence >= 1),
  lease_until          TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('running', 'complete', 'abandoned')),
  snapshot_id          TEXT,
  snapshot_blob_sha256 TEXT CHECK (snapshot_blob_sha256 IS NULL OR (length(snapshot_blob_sha256) = 64 AND snapshot_blob_sha256 = lower(snapshot_blob_sha256) AND snapshot_blob_sha256 NOT GLOB '*[^0-9a-f]*')),
  stamp                TEXT,
  cursor               TEXT CHECK (cursor IS NULL OR length(cursor) <= 4096),
  seen_count           INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
  pending_validators   TEXT CHECK (pending_validators IS NULL OR CASE WHEN json_valid(pending_validators) THEN json_type(pending_validators) = 'object' ELSE 0 END),
  pages_so_far         INTEGER NOT NULL DEFAULT 0 CHECK (pages_so_far >= 0),
  started_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK ((scope = 'package') = (package_key IS NOT NULL))
) STRICT;

-- ---------------------------------------------------------------------------
-- Catalogue and vulnerability results
-- ---------------------------------------------------------------------------

CREATE TABLE package (
  id                      TEXT NOT NULL PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES organization (id),
  source_id               TEXT NOT NULL,
  ecosystem               TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  name                    TEXT NOT NULL CHECK (name = lower(name)),
  description             TEXT,
  visible_to_new_projects INTEGER NOT NULL DEFAULT 1 CHECK (visible_to_new_projects IN (0, 1)),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed_upstream')),
  removed_upstream_at     TEXT,
  rev                     INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  modified_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_synced_at          TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  removal_cause           TEXT CHECK (removal_cause IS NULL OR removal_cause IN ('document_absent', 'source_listing')),
  last_op_id              TEXT,
  listing_open_stamp      TEXT,
  listing_seen_stamp      TEXT,
  listing_opened_at       TEXT,
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id)
) STRICT;

CREATE TABLE project_package (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  origin     TEXT NOT NULL CHECK (origin IN ('subscription', 'explicit', 'pattern')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ecosystem  TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  name       TEXT NOT NULL CHECK (name = lower(name)),
  PRIMARY KEY (project_id, package_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE project_package_pattern (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  pattern    TEXT NOT NULL CHECK (pattern = lower(pattern)),
  effect     TEXT NOT NULL CHECK (effect IN ('include', 'exclude')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id)
) STRICT;

CREATE TABLE project_source (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 100 CHECK (precedence >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, source_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE registered_name (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  source_id  TEXT NOT NULL,
  ecosystem  TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  pattern    TEXT NOT NULL CHECK (pattern = lower(pattern)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE upstream_state (
  org_id             TEXT NOT NULL REFERENCES organization (id),
  package_id         TEXT NOT NULL REFERENCES package (id) ON DELETE CASCADE,
  form               TEXT NOT NULL CHECK (form IN ('composer-p2', 'composer-p2-dev', 'composer-v1-provider', 'npm-packument')),
  etag               TEXT,
  last_modified      TEXT,
  content_sha256     TEXT CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 = lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*')),
  checked_at         TEXT NOT NULL,
  fresh_until        TEXT NOT NULL,
  not_found_count    INTEGER NOT NULL DEFAULT 0 CHECK (not_found_count >= 0),
  first_not_found_at TEXT,
  PRIMARY KEY (package_id, form)
) STRICT, WITHOUT ROWID;

CREATE TABLE version (
  id                   TEXT NOT NULL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization (id),
  package_id           TEXT NOT NULL,
  version              TEXT NOT NULL,
  version_normalized   TEXT NOT NULL,
  stability            TEXT NOT NULL DEFAULT 'stable' CHECK (stability IN ('dev', 'alpha', 'beta', 'RC', 'stable')),
  published_at         TEXT NOT NULL,
  published_at_basis   TEXT NOT NULL,
  upstream_released_at TEXT,
  license              TEXT,
  blob_id              TEXT REFERENCES blob (id),
  dist_type            TEXT CHECK (dist_type IS NULL OR dist_type IN ('zip', 'tar', 'tgz')),
  composer_shasum      TEXT,
  npm_integrity        TEXT,
  source_ref           TEXT,
  metadata_json        TEXT NOT NULL CHECK (json_valid(metadata_json)),
  deprecated_message   TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed_upstream', 'yanked', 'quarantined', 'tombstoned')),
  removed_upstream_at  TEXT,
  tombstoned_at        TEXT,
  tombstone_reason     TEXT,
  purge_after          TEXT,
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_op_id           TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  listing_seen_stamp   TEXT,
  CHECK (status <> 'tombstoned' OR tombstoned_at IS NOT NULL),
  CHECK (status <> 'removed_upstream' OR removed_upstream_at IS NOT NULL),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id)
) STRICT;

CREATE TABLE version_revision (
  id            TEXT NOT NULL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization (id),
  version_id    TEXT NOT NULL REFERENCES version (id),
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  blob_id       TEXT REFERENCES blob (id),
  source_ref    TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  reason        TEXT NOT NULL,
  op_id         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE vulnerability_result (
  org_id          TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  version_id      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'osv' CHECK (source = 'osv'),
  package_id      TEXT NOT NULL,
  ecosystem       TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  package_key     TEXT NOT NULL,
  version         TEXT NOT NULL,
  query_version   TEXT NOT NULL,
  mapping_version INTEGER NOT NULL CHECK (mapping_version > 0),
  assessment      TEXT CHECK (assessment IN ('affected', 'not_affected')),
  fetched_at      TEXT CHECK (fetched_at IS NULL OR (length(fetched_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at) IS fetched_at)),
  attempted_at    TEXT NOT NULL CHECK (length(attempted_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) IS attempted_at),
  next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at),
  failure_count   INTEGER NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 1000),
  last_error_code TEXT CHECK (last_error_code IN ('unavailable', 'protocol', 'config', 'limit')),
  generation      INTEGER NOT NULL CHECK (generation >= 0),
  refresh_id      TEXT,
  PRIMARY KEY (org_id, version_id, source),
  UNIQUE (org_id, ecosystem, package_id, version_id, source),
  FOREIGN KEY (org_id, version_id) REFERENCES version(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, package_id) REFERENCES package(org_id, id) ON DELETE CASCADE,
  CHECK ((assessment IS NULL) = (fetched_at IS NULL))
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Package grants, tags and import history
-- ---------------------------------------------------------------------------

CREATE TABLE bundle_item (
  org_id             TEXT NOT NULL REFERENCES organization (id),
  bundle_id          TEXT NOT NULL REFERENCES bundle (id),
  bundle_revision    INTEGER NOT NULL CHECK (bundle_revision >= 1),
  package_id         TEXT NOT NULL REFERENCES package (id),
  version_constraint TEXT,
  PRIMARY KEY (bundle_id, bundle_revision, package_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE customer_grant (
  id                 TEXT NOT NULL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organization (id),
  customer_id        TEXT NOT NULL REFERENCES customer (id),
  project_id         TEXT NOT NULL REFERENCES project (id),
  package_id         TEXT REFERENCES package (id),
  bundle_id          TEXT REFERENCES bundle (id),
  version_constraint TEXT,
  minimum_stability  TEXT NOT NULL DEFAULT 'stable' CHECK (minimum_stability IN ('dev', 'alpha', 'beta', 'RC', 'stable')),
  valid_until        TEXT,
  revoked_at         TEXT,
  row_version        INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  last_op_id         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((package_id IS NOT NULL AND bundle_id IS NULL) OR (package_id IS NULL AND bundle_id IS NOT NULL))
) STRICT;

CREATE TABLE dist_tag (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  package_id TEXT NOT NULL,
  tag        TEXT NOT NULL,
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (package_id, tag),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id),
  FOREIGN KEY (org_id, version_id) REFERENCES version (org_id, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE dist_tag_history (
  id                  TEXT NOT NULL PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organization (id),
  package_id          TEXT NOT NULL,
  tag                 TEXT NOT NULL,
  version_id          TEXT,
  previous_version_id TEXT,
  action              TEXT NOT NULL CHECK (action IN ('set', 'remove')),
  actor_type          TEXT NOT NULL,
  actor_id            TEXT,
  op_id               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id),
  FOREIGN KEY (org_id, version_id) REFERENCES version (org_id, id),
  FOREIGN KEY (org_id, previous_version_id) REFERENCES version (org_id, id)
) STRICT;

CREATE TABLE import_ref (
  id                 TEXT NOT NULL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organization (id),
  import_run_id      TEXT NOT NULL REFERENCES import_run (id),
  entity_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  external_ref       TEXT NOT NULL,
  action             TEXT NOT NULL CHECK (action IN ('create', 'update')),
  before_image_json  TEXT CHECK (before_image_json IS NULL OR json_valid(before_image_json)),
  content_hash       TEXT,
  conflict_state     TEXT NOT NULL DEFAULT 'none' CHECK (conflict_state IN ('none', 'changed_after_import', 'resolved')),
  rolled_back_at     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at_basis TEXT CHECK (published_at_basis IS NULL OR published_at_basis IN ('source_release', 'packagist_added', 'import_time')),
  expired_at         TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- Advisory matches and refreshes
-- ---------------------------------------------------------------------------

CREATE TABLE vulnerability_match (
  org_id               TEXT NOT NULL,
  version_id           TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'osv' CHECK (source = 'osv'),
  advisory_id          TEXT NOT NULL CHECK (length(CAST(advisory_id AS BLOB)) BETWEEN 1 AND 200 AND instr(advisory_id, '/') = 0 AND instr(advisory_id, char(92)) = 0 AND advisory_id NOT IN ('.', '..')),
  advisory_modified_at TEXT CHECK (advisory_modified_at IS NULL OR (length(advisory_modified_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', advisory_modified_at) IS advisory_modified_at)),
  PRIMARY KEY (org_id, version_id, source, advisory_id),
  FOREIGN KEY (org_id, version_id, source) REFERENCES vulnerability_result(org_id, version_id, source) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE vulnerability_refresh (
  org_id               TEXT NOT NULL,
  refresh_id           TEXT NOT NULL CHECK (length(refresh_id) BETWEEN 1 AND 200),
  version_id           TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'osv' CHECK (source = 'osv'),
  generation           INTEGER NOT NULL CHECK (generation >= 0),
  mapping_version      INTEGER NOT NULL CHECK (mapping_version > 0),
  query_version        TEXT NOT NULL,
  continuation_token   TEXT NOT NULL CHECK (length(CAST(continuation_token AS BLOB)) BETWEEN 1 AND 4096),
  page_count           INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 4),
  accumulated_ids_json TEXT NOT NULL CHECK (length(CAST(accumulated_ids_json AS BLOB)) <= 65536 AND json_valid(accumulated_ids_json) AND json_type(accumulated_ids_json) = 'array' AND json_array_length(accumulated_ids_json) <= 200),
  started_at           TEXT NOT NULL CHECK (length(started_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
  next_attempt_at      TEXT NOT NULL CHECK (length(next_attempt_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at),
  PRIMARY KEY (org_id, refresh_id),
  UNIQUE (org_id, version_id, source),
  FOREIGN KEY (org_id, version_id, source) REFERENCES vulnerability_result(org_id, version_id, source) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Indexes (original chain creation order)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX organization_singleton ON organization (singleton);
CREATE UNIQUE INDEX user_account_email ON user_account (org_id, email);
CREATE UNIQUE INDEX identity_subject ON identity (org_id, provider, subject);
CREATE INDEX identity_user ON identity (user_id);
CREATE INDEX user_group_name ON user_group (org_id, provider, group_name, user_id);
CREATE UNIQUE INDEX session_secret ON session (secret_hash);
CREATE INDEX session_user ON session (user_id, expires_at);
CREATE INDEX session_identity ON session (identity_id);
CREATE INDEX session_expiry ON session (expires_at);
CREATE UNIQUE INDEX role_key ON role (org_id, key);
CREATE UNIQUE INDEX project_slug ON project (org_id, slug);
CREATE UNIQUE INDEX access_grant_org_scope ON access_grant (org_id, subject_type, subject_provider, subject_value) WHERE subject_type = 'group' AND scope = 'organization';
CREATE UNIQUE INDEX access_grant_project_scope ON access_grant (project_id, subject_type, subject_provider, subject_value) WHERE subject_type = 'group' AND scope = 'project';
CREATE UNIQUE INDEX access_grant_org_scope_email ON access_grant (org_id, subject_type, subject_value) WHERE subject_type = 'email' AND scope = 'organization';
CREATE UNIQUE INDEX access_grant_project_scope_email ON access_grant (project_id, subject_type, subject_value) WHERE subject_type = 'email' AND scope = 'project';
CREATE INDEX access_grant_subject ON access_grant (org_id, subject_type, subject_provider, subject_value, project_id);
CREATE INDEX access_grant_project ON access_grant (project_id);
CREATE INDEX access_grant_role ON access_grant (role_id);
CREATE INDEX credential_key_version ON credential (org_id, key_version);
CREATE INDEX credential_project ON credential (project_id);
CREATE UNIQUE INDEX source_name_org ON source (org_id, name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX source_name_project ON source (project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX source_project ON source (project_id);
CREATE INDEX source_credential ON source (credential_id);
CREATE INDEX source_due ON source (next_poll_at) WHERE status <> 'paused';
CREATE UNIQUE INDEX blob_digest ON blob (org_id, sha256);
CREATE UNIQUE INDEX blob_storage_key ON blob (org_id, storage_key);
CREATE INDEX blob_purge ON blob (purge_after) WHERE purge_after IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX blob_idle ON blob (last_accessed_at) WHERE refetchable = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX version_revision_identity ON version_revision (version_id, revision);
CREATE INDEX version_revision_blob ON version_revision (blob_id);
CREATE UNIQUE INDEX customer_external_ref ON customer (org_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX bundle_name ON bundle (org_id, name);
CREATE INDEX bundle_item_package ON bundle_item (package_id);
CREATE UNIQUE INDEX customer_grant_package ON customer_grant (customer_id, project_id, package_id) WHERE package_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX customer_grant_bundle ON customer_grant (customer_id, project_id, bundle_id) WHERE bundle_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX customer_grant_customer ON customer_grant (customer_id);
CREATE INDEX customer_grant_project ON customer_grant (project_id);
CREATE INDEX customer_grant_package_fk ON customer_grant (package_id);
CREATE INDEX customer_grant_bundle_fk ON customer_grant (bundle_id);
CREATE UNIQUE INDEX service_principal_name ON service_principal (org_id, name);
CREATE INDEX service_principal_project ON service_principal (project_id);
CREATE INDEX service_principal_creator ON service_principal (created_by_user_id);
CREATE UNIQUE INDEX token_selector ON token (selector);
CREATE INDEX token_user ON token (user_id);
CREATE INDEX token_service_principal ON token (service_principal_id);
CREATE INDEX token_customer ON token (customer_id);
CREATE INDEX token_binding_project ON token (project_id);
CREATE INDEX token_creator ON token (created_by_user_id);
CREATE INDEX token_project_project ON token_project (project_id);
CREATE UNIQUE INDEX audit_event_seq ON audit_event (org_id, seq);
CREATE UNIQUE INDEX audit_event_prev_hash ON audit_event (org_id, prev_hash);
CREATE INDEX audit_event_project ON audit_event (org_id, project_id, seq);
CREATE INDEX audit_event_target ON audit_event (org_id, target_type, target_id, seq);
CREATE INDEX audit_event_actor ON audit_event (org_id, actor_id, seq);
CREATE UNIQUE INDEX job_one_running_per_resource ON job (org_id, resource_key) WHERE state = 'running' AND resource_key IS NOT NULL;
CREATE UNIQUE INDEX job_idempotency ON job (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX job_queued_resource ON job (org_id, resource_key, type) WHERE state = 'queued' AND resource_key IS NOT NULL;
CREATE INDEX job_dead ON job (org_id, finished_at) WHERE state = 'dead';
CREATE INDEX job_schedule_due ON job_schedule (next_run_at) WHERE enabled = 1;
CREATE INDEX import_run_starter ON import_run (started_by_user_id);
CREATE INDEX import_run_state ON import_run (org_id, state);
CREATE UNIQUE INDEX import_ref_run_external ON import_ref (import_run_id, entity_type, external_ref);
CREATE INDEX import_ref_entity ON import_ref (org_id, entity_type, entity_id);
CREATE INDEX import_ref_external ON import_ref (org_id, entity_type, external_ref);
CREATE INDEX webhook_delivery_source ON webhook_delivery (source_id);
CREATE INDEX webhook_delivery_received ON webhook_delivery (received_at);
CREATE UNIQUE INDEX local_login_setup ON local_login (setup_hash) WHERE setup_hash IS NOT NULL;
CREATE INDEX local_login_org ON local_login (org_id);
CREATE UNIQUE INDEX local_login_totp ON local_login (totp_credential_id) WHERE totp_credential_id IS NOT NULL;
CREATE INDEX token_validation_identity ON token (validation_identity_id) WHERE validation_identity_id IS NOT NULL;
CREATE UNIQUE INDEX service_principal_org_id ON service_principal (org_id, id);
CREATE INDEX identity_block_user ON identity_block (blocked_by_user_id) WHERE blocked_by_user_id IS NOT NULL;
CREATE UNIQUE INDEX job_attempt_fence ON job_attempt (job_id, fence);
CREATE UNIQUE INDEX ingest_session_running_scope ON ingest_session (org_id, scope_key) WHERE state = 'running';
CREATE INDEX ingest_session_state_lease ON ingest_session (state, lease_until);
CREATE INDEX ingest_session_scope_generation ON ingest_session (org_id, scope_key, generation);
CREATE INDEX fetch_lease_expiry ON fetch_lease (lease_until);
CREATE INDEX upstream_state_content ON upstream_state (org_id, content_sha256);
CREATE INDEX ingest_session_snapshot_blob ON ingest_session (org_id, snapshot_blob_sha256);
CREATE INDEX job_claim_org ON job(org_id, run_at, id) WHERE state = 'queued';
CREATE INDEX job_lease_org ON job(org_id, lease_until) WHERE state = 'running';
CREATE INDEX audit_pending_org_id ON audit_pending (org_id, id);
CREATE INDEX api_idempotency_expiry ON api_idempotency (org_id, expires_at);
CREATE INDEX audit_event_action ON audit_event (org_id, action, seq);
CREATE INDEX import_run_approver ON import_run (approved_by_user_id);
CREATE INDEX import_run_sp_starter ON import_run (started_by_service_principal_id);
CREATE INDEX token_pepper_version ON token (pepper_version);
CREATE INDEX credential_version_in_use ON credential (key_version);
CREATE UNIQUE INDEX source_org_id ON source (id, org_id);
CREATE UNIQUE INDEX project_org_id ON project (id, org_id);
CREATE INDEX package_by_name ON package (org_id, ecosystem, name);
CREATE UNIQUE INDEX package_identity ON package (org_id, ecosystem, source_id, name);
CREATE INDEX package_source ON package (source_id);
CREATE UNIQUE INDEX package_org_id ON package (id, org_id);
CREATE INDEX dist_tag_version ON dist_tag (version_id);
CREATE UNIQUE INDEX project_package_pattern_identity ON project_package_pattern (project_id, source_id, pattern);
CREATE INDEX project_package_pattern_source ON project_package_pattern (source_id);
CREATE INDEX project_source_source ON project_source (source_id);
CREATE UNIQUE INDEX version_org_id ON version (id, org_id);
CREATE INDEX version_blob ON version (blob_id);
CREATE INDEX version_by_published ON version (package_id, published_at);
CREATE UNIQUE INDEX version_identity ON version (package_id, version_normalized);
CREATE INDEX version_op ON version (last_op_id) WHERE last_op_id IS NOT NULL;
CREATE INDEX version_purge ON version (purge_after) WHERE purge_after IS NOT NULL;
CREATE INDEX dist_tag_history_previous ON dist_tag_history (previous_version_id);
CREATE INDEX dist_tag_history_tag ON dist_tag_history (package_id, tag, created_at);
CREATE INDEX dist_tag_history_version ON dist_tag_history (version_id);
CREATE UNIQUE INDEX registered_name_pattern ON registered_name (org_id, ecosystem, pattern);
CREATE INDEX registered_name_source ON registered_name (source_id);
CREATE INDEX vulnerability_result_due ON vulnerability_result (org_id, source, next_attempt_at, version_id);
CREATE INDEX vulnerability_match_advisory ON vulnerability_match (org_id, source, advisory_id);
CREATE INDEX vulnerability_advisory_due ON vulnerability_advisory (org_id, source, next_attempt_at, advisory_id);
CREATE INDEX vulnerability_refresh_due ON vulnerability_refresh (org_id, next_attempt_at, refresh_id);
CREATE INDEX vulnerability_source_evidence ON source (org_id, ecosystem, id) WHERE ecosystem IN ('composer', 'npm');
CREATE INDEX vulnerability_version_due ON version (org_id, id) WHERE length(CAST(version AS BLOB)) BETWEEN 1 AND 200;
CREATE INDEX version_package_status ON version (package_id, status);
CREATE INDEX project_package_package ON project_package (package_id);
CREATE INDEX project_package_name ON project_package (org_id, project_id, ecosystem, name);
CREATE INDEX version_package_id ON version (package_id, id);

-- ---------------------------------------------------------------------------
-- Initial migration lock
-- ---------------------------------------------------------------------------

INSERT INTO migration_lock (id) VALUES (1);
