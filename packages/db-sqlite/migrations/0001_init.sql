-- Package Broker 2.0, migration 0001. SQLite dialect (Cloudflare D1, better-sqlite3).
-- No BEGIN/COMMIT: the runner applies the file as one batch. No PRAGMA: D1 always enforces
-- foreign keys; better-sqlite3 and the sqlite3 CLI need PRAGMA foreign_keys = ON per connection.
-- Timestamps: ISO-8601 UTC text with milliseconds and a Z suffix (strftime('%Y-%m-%dT%H:%M:%fZ')).
-- Booleans: INTEGER 0/1 with CHECK. Keys: ULID text. org_id is a constant, see schema-notes.md.

-- ---------------------------------------------------------------------------
-- Organization (singleton), identity, sessions, roles, grants
-- ---------------------------------------------------------------------------

CREATE TABLE organization (
  id                                TEXT NOT NULL PRIMARY KEY,
  singleton                         INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1),
  slug                              TEXT NOT NULL CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 64),
  name                              TEXT NOT NULL,
  retention_removed_upstream_days   INTEGER NOT NULL DEFAULT 365 CHECK (retention_removed_upstream_days >= 0),
  token_default_expiry_days         INTEGER NOT NULL DEFAULT 90 CHECK (token_default_expiry_days > 0),
  token_ci_readonly_expiry_days     INTEGER NOT NULL DEFAULT 365 CHECK (token_ci_readonly_expiry_days > 0),
  created_at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX organization_singleton ON organization (singleton);

CREATE TABLE user_account (
  id               TEXT NOT NULL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organization (id),
  email            TEXT NOT NULL CHECK (email = lower(email)),
  display_name     TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  last_login_at    TEXT,
  idp_validated_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX user_account_email ON user_account (org_id, email);

CREATE TABLE identity (
  id             TEXT NOT NULL PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organization (id),
  user_id        TEXT NOT NULL REFERENCES user_account (id),
  provider       TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  subject        TEXT NOT NULL,
  email          TEXT NOT NULL CHECK (email = lower(email)),
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX identity_subject ON identity (org_id, provider, subject);
CREATE INDEX identity_user ON identity (user_id);

CREATE TABLE user_group (
  org_id       TEXT NOT NULL REFERENCES organization (id),
  user_id      TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  group_name   TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, provider, group_name)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_group_name ON user_group (org_id, provider, group_name, user_id);

CREATE TABLE session (
  id            TEXT NOT NULL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization (id),
  user_id       TEXT NOT NULL REFERENCES user_account (id),
  identity_id   TEXT REFERENCES identity (id),
  secret_hash   TEXT NOT NULL CHECK (length(secret_hash) = 64),
  csrf_hash     TEXT NOT NULL CHECK (length(csrf_hash) = 64),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  reauth_at     TEXT,
  revoked_at    TEXT,
  ip            TEXT,
  user_agent    TEXT
) STRICT;
CREATE UNIQUE INDEX session_secret ON session (secret_hash);
CREATE INDEX session_user ON session (user_id, expires_at);
CREATE INDEX session_identity ON session (identity_id);
CREATE INDEX session_expiry ON session (expires_at);

CREATE TABLE role (
  id                   TEXT NOT NULL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization (id),
  key                  TEXT NOT NULL CHECK (key = lower(key)),
  name                 TEXT NOT NULL,
  scope                TEXT NOT NULL CHECK (scope IN ('organization', 'project')),
  is_system            INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  protects_last_holder INTEGER NOT NULL DEFAULT 0 CHECK (protects_last_holder IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX role_key ON role (org_id, key);

CREATE TABLE role_permission (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  role_id    TEXT NOT NULL REFERENCES role (id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
) STRICT, WITHOUT ROWID;

CREATE TABLE project (
  id                       TEXT NOT NULL PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organization (id),
  slug                     TEXT NOT NULL CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 64),
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  token_max_scope          TEXT NOT NULL DEFAULT 'full' CHECK (token_max_scope IN ('read', 'write', 'full')),
  require_publish_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_publish_approval IN (0, 1)),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX project_slug ON project (org_id, slug);

CREATE TABLE access_grant (
  id            TEXT NOT NULL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization (id),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('group', 'email')),
  subject_value TEXT NOT NULL CHECK (subject_type = 'group' OR subject_value = lower(subject_value)),
  subject_provider TEXT CHECK ((subject_type = 'group' AND subject_provider IS NOT NULL AND length(subject_provider) BETWEEN 1 AND 64 AND subject_provider = trim(subject_provider)) OR (subject_type = 'email' AND subject_provider IS NULL)),
  scope         TEXT NOT NULL CHECK (scope IN ('organization', 'project')),
  project_id    TEXT REFERENCES project (id),
  role_id       TEXT NOT NULL REFERENCES role (id),
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((scope = 'organization' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX access_grant_org_scope ON access_grant (org_id, subject_type, subject_provider, subject_value) WHERE subject_type = 'group' AND scope = 'organization';
CREATE UNIQUE INDEX access_grant_project_scope ON access_grant (project_id, subject_type, subject_provider, subject_value) WHERE subject_type = 'group' AND scope = 'project';
CREATE UNIQUE INDEX access_grant_org_scope_email ON access_grant (org_id, subject_type, subject_value) WHERE subject_type = 'email' AND scope = 'organization';
CREATE UNIQUE INDEX access_grant_project_scope_email ON access_grant (project_id, subject_type, subject_value) WHERE subject_type = 'email' AND scope = 'project';
CREATE INDEX access_grant_subject ON access_grant (org_id, subject_type, subject_provider, subject_value, project_id);
CREATE INDEX access_grant_project ON access_grant (project_id);
CREATE INDEX access_grant_role ON access_grant (role_id);

-- ---------------------------------------------------------------------------
-- Credentials, sources, packages, versions, blobs
-- ---------------------------------------------------------------------------

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
CREATE INDEX credential_key_version ON credential (org_id, key_version);
CREATE INDEX credential_project ON credential (project_id);

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
  updated_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX source_name_org ON source (org_id, name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX source_name_project ON source (project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX source_project ON source (project_id);
CREATE INDEX source_credential ON source (credential_id);
CREATE INDEX source_due ON source (next_poll_at) WHERE status <> 'paused';

CREATE TABLE registered_name (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  source_id  TEXT NOT NULL REFERENCES source (id) ON DELETE CASCADE,
  ecosystem  TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  pattern    TEXT NOT NULL CHECK (pattern = lower(pattern)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX registered_name_pattern ON registered_name (org_id, ecosystem, pattern);
CREATE INDEX registered_name_source ON registered_name (source_id);

CREATE TABLE blob (
  id               TEXT NOT NULL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organization (id),
  sha256           TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_key      TEXT NOT NULL,
  media_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  refetchable      INTEGER NOT NULL DEFAULT 1 CHECK (refetchable IN (0, 1)),
  upstream_url     TEXT,
  last_fetched_at  TEXT,
  last_accessed_at TEXT,
  purge_after      TEXT,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX blob_digest ON blob (org_id, sha256);
CREATE UNIQUE INDEX blob_storage_key ON blob (org_id, storage_key);
CREATE INDEX blob_purge ON blob (purge_after) WHERE purge_after IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX blob_idle ON blob (last_accessed_at) WHERE refetchable = 1 AND deleted_at IS NULL;

CREATE TABLE package (
  id                         TEXT NOT NULL PRIMARY KEY,
  org_id                     TEXT NOT NULL REFERENCES organization (id),
  source_id                  TEXT NOT NULL REFERENCES source (id),
  ecosystem                  TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  name                       TEXT NOT NULL CHECK (name = lower(name)),
  description                TEXT,
  visible_to_new_projects    INTEGER NOT NULL DEFAULT 1 CHECK (visible_to_new_projects IN (0, 1)),
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed_upstream')),
  removed_upstream_at        TEXT,
  rev                        INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  modified_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_synced_at             TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX package_identity ON package (org_id, ecosystem, source_id, name);
CREATE INDEX package_by_name ON package (org_id, ecosystem, name);
CREATE INDEX package_source ON package (source_id);

CREATE TABLE version (
  id                   TEXT NOT NULL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization (id),
  package_id           TEXT NOT NULL REFERENCES package (id),
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
  CHECK (status <> 'tombstoned' OR tombstoned_at IS NOT NULL),
  CHECK (status <> 'removed_upstream' OR removed_upstream_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX version_identity ON version (package_id, version_normalized);
CREATE INDEX version_by_published ON version (package_id, published_at);
CREATE INDEX version_blob ON version (blob_id);
CREATE INDEX version_op ON version (last_op_id) WHERE last_op_id IS NOT NULL;
CREATE INDEX version_purge ON version (purge_after) WHERE purge_after IS NOT NULL;

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
CREATE UNIQUE INDEX version_revision_identity ON version_revision (version_id, revision);
CREATE INDEX version_revision_blob ON version_revision (blob_id);

CREATE TABLE dist_tag (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  package_id TEXT NOT NULL REFERENCES package (id),
  tag        TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES version (id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (package_id, tag)
) STRICT, WITHOUT ROWID;
CREATE INDEX dist_tag_version ON dist_tag (version_id);

CREATE TABLE dist_tag_history (
  id                  TEXT NOT NULL PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organization (id),
  package_id          TEXT NOT NULL REFERENCES package (id),
  tag                 TEXT NOT NULL,
  version_id          TEXT REFERENCES version (id),
  previous_version_id TEXT REFERENCES version (id),
  action              TEXT NOT NULL CHECK (action IN ('set', 'remove')),
  actor_type          TEXT NOT NULL,
  actor_id            TEXT,
  op_id               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX dist_tag_history_tag ON dist_tag_history (package_id, tag, created_at);
CREATE INDEX dist_tag_history_version ON dist_tag_history (version_id);
CREATE INDEX dist_tag_history_previous ON dist_tag_history (previous_version_id);

-- ---------------------------------------------------------------------------
-- Project visibility: source attachment, package subset
-- ---------------------------------------------------------------------------

CREATE TABLE project_source (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL REFERENCES project (id),
  source_id  TEXT NOT NULL REFERENCES source (id),
  precedence INTEGER NOT NULL DEFAULT 100 CHECK (precedence >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, source_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX project_source_source ON project_source (source_id);

CREATE TABLE project_package (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL REFERENCES project (id),
  package_id TEXT NOT NULL REFERENCES package (id),
  origin     TEXT NOT NULL CHECK (origin IN ('subscription', 'explicit', 'pattern')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, package_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX project_package_package ON project_package (package_id);

CREATE TABLE project_package_pattern (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL REFERENCES project (id),
  source_id  TEXT NOT NULL REFERENCES source (id),
  pattern    TEXT NOT NULL CHECK (pattern = lower(pattern)),
  effect     TEXT NOT NULL CHECK (effect IN ('include', 'exclude')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX project_package_pattern_identity ON project_package_pattern (project_id, source_id, pattern);
CREATE INDEX project_package_pattern_source ON project_package_pattern (source_id);

-- ---------------------------------------------------------------------------
-- Customers and licence freeze (P1, PB-43): tables exist now so the freeze needs no breaking migration
-- ---------------------------------------------------------------------------

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
CREATE UNIQUE INDEX customer_external_ref ON customer (org_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE bundle (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  name       TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX bundle_name ON bundle (org_id, name);

CREATE TABLE bundle_item (
  org_id             TEXT NOT NULL REFERENCES organization (id),
  bundle_id          TEXT NOT NULL REFERENCES bundle (id),
  bundle_revision    INTEGER NOT NULL CHECK (bundle_revision >= 1),
  package_id         TEXT NOT NULL REFERENCES package (id),
  version_constraint TEXT,
  PRIMARY KEY (bundle_id, bundle_revision, package_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX bundle_item_package ON bundle_item (package_id);

CREATE TABLE customer_grant (
  id                TEXT NOT NULL PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organization (id),
  customer_id       TEXT NOT NULL REFERENCES customer (id),
  project_id        TEXT NOT NULL REFERENCES project (id),
  package_id        TEXT REFERENCES package (id),
  bundle_id         TEXT REFERENCES bundle (id),
  version_constraint TEXT,
  minimum_stability TEXT NOT NULL DEFAULT 'stable' CHECK (minimum_stability IN ('dev', 'alpha', 'beta', 'RC', 'stable')),
  valid_until       TEXT,
  revoked_at        TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  last_op_id        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((package_id IS NOT NULL AND bundle_id IS NULL) OR (package_id IS NULL AND bundle_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX customer_grant_package ON customer_grant (customer_id, project_id, package_id) WHERE package_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX customer_grant_bundle ON customer_grant (customer_id, project_id, bundle_id) WHERE bundle_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX customer_grant_customer ON customer_grant (customer_id);
CREATE INDEX customer_grant_project ON customer_grant (project_id);
CREATE INDEX customer_grant_package_fk ON customer_grant (package_id);
CREATE INDEX customer_grant_bundle_fk ON customer_grant (bundle_id);

-- ---------------------------------------------------------------------------
-- Service principals and tokens
-- ---------------------------------------------------------------------------

CREATE TABLE service_principal (
  id                 TEXT NOT NULL PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organization (id),
  name               TEXT NOT NULL,
  project_id         TEXT REFERENCES project (id),
  created_by_user_id TEXT NOT NULL REFERENCES user_account (id),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX service_principal_name ON service_principal (org_id, name);
CREATE INDEX service_principal_project ON service_principal (project_id);
CREATE INDEX service_principal_creator ON service_principal (created_by_user_id);

CREATE TABLE token (
  id                   TEXT NOT NULL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization (id),
  kind                 TEXT NOT NULL CHECK (kind IN ('pat', 'svc', 'cst')),
  selector             TEXT NOT NULL CHECK (length(selector) = 12),
  hash                 TEXT NOT NULL CHECK (length(hash) = 64),
  pepper_version       INTEGER NOT NULL CHECK (pepper_version >= 1),
  name                 TEXT NOT NULL,
  scopes_json          TEXT NOT NULL CHECK (json_valid(scopes_json)),
  read_only            INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  user_id              TEXT REFERENCES user_account (id),
  service_principal_id TEXT REFERENCES service_principal (id),
  customer_id          TEXT REFERENCES customer (id),
  project_id           TEXT REFERENCES project (id),
  created_by_user_id   TEXT REFERENCES user_account (id),
  expires_at           TEXT,
  revoked_at           TEXT,
  last_used_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (kind = 'pat' AND user_id IS NOT NULL AND service_principal_id IS NULL AND customer_id IS NULL) OR
    (kind = 'svc' AND service_principal_id IS NOT NULL AND user_id IS NULL AND customer_id IS NULL) OR
    (kind = 'cst' AND customer_id IS NOT NULL AND user_id IS NULL AND service_principal_id IS NULL)
  ),
  CHECK (kind = 'cst' OR expires_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX token_selector ON token (selector);
CREATE INDEX token_user ON token (user_id);
CREATE INDEX token_service_principal ON token (service_principal_id);
CREATE INDEX token_customer ON token (customer_id);
CREATE INDEX token_binding_project ON token (project_id);
CREATE INDEX token_creator ON token (created_by_user_id);

CREATE TABLE token_project (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  token_id   TEXT NOT NULL REFERENCES token (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project (id),
  PRIMARY KEY (token_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX token_project_project ON token_project (project_id);

-- ---------------------------------------------------------------------------
-- Audit log (hash chain), jobs, scheduler
-- ---------------------------------------------------------------------------

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
CREATE UNIQUE INDEX audit_event_seq ON audit_event (org_id, seq);
CREATE UNIQUE INDEX audit_event_prev_hash ON audit_event (org_id, prev_hash);
CREATE INDEX audit_event_project ON audit_event (org_id, project_id, seq);
CREATE INDEX audit_event_target ON audit_event (org_id, target_type, target_id, seq);
CREATE INDEX audit_event_actor ON audit_event (org_id, actor_id, seq);

CREATE TABLE job (
  id              TEXT NOT NULL PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organization (id),
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(payload_json) <= 131072),
  resource_key    TEXT,
  idempotency_key TEXT,
  state           TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  lease_owner     TEXT,
  lease_until     TEXT,
  fence           INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
  run_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_error      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (state <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX job_one_running_per_resource ON job (org_id, resource_key) WHERE state = 'running' AND resource_key IS NOT NULL;
CREATE UNIQUE INDEX job_idempotency ON job (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX job_claim ON job (run_at, id) WHERE state = 'queued';
CREATE INDEX job_lease ON job (lease_until) WHERE state = 'running';
CREATE INDEX job_queued_resource ON job (org_id, resource_key, type) WHERE state = 'queued' AND resource_key IS NOT NULL;
CREATE INDEX job_dead ON job (org_id, finished_at) WHERE state = 'dead';

CREATE TABLE job_attempt (
  id          TEXT NOT NULL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organization (id),
  job_id      TEXT NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL CHECK (attempt >= 1),
  fence       INTEGER NOT NULL CHECK (fence >= 1),
  worker      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'succeeded', 'failed', 'lease_expired', 'dead')),
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  next_run_at TEXT
) STRICT;
CREATE UNIQUE INDEX job_attempt_fence ON job_attempt (job_id, fence);

CREATE TABLE job_schedule (
  org_id         TEXT NOT NULL REFERENCES organization (id),
  name           TEXT NOT NULL,
  every_seconds  INTEGER CHECK (every_seconds IS NULL OR every_seconds > 0),
  cron           TEXT,
  next_run_at    TEXT NOT NULL,
  last_slot      TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (org_id, name),
  CHECK (every_seconds IS NOT NULL OR cron IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX job_schedule_due ON job_schedule (next_run_at) WHERE enabled = 1;

-- ---------------------------------------------------------------------------
-- Migration bookkeeping (deployment level: no org_id)
-- ---------------------------------------------------------------------------

CREATE TABLE schema_migration (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE migration_lock (
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  holder      TEXT,
  acquired_at TEXT,
  expires_at  TEXT
) STRICT;
INSERT INTO migration_lock (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- Import runs, webhook deduplication
-- ---------------------------------------------------------------------------

CREATE TABLE import_run (
  id                      TEXT NOT NULL PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES organization (id),
  source_system           TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'applying', 'failed', 'applied', 'verifying', 'verified', 'rolled_back', 'cancelled')),
  plan_hash               TEXT,
  planned_count           INTEGER NOT NULL DEFAULT 0 CHECK (planned_count >= 0),
  applied_count           INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  started_by_user_id      TEXT REFERENCES user_account (id),
  before_image_expires_at TEXT,
  accepted_at             TEXT,
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX import_run_starter ON import_run (started_by_user_id);
CREATE INDEX import_run_state ON import_run (org_id, state);

CREATE TABLE import_ref (
  id                TEXT NOT NULL PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organization (id),
  import_run_id     TEXT NOT NULL REFERENCES import_run (id),
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  external_ref      TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('create', 'update')),
  before_image_json TEXT CHECK (before_image_json IS NULL OR json_valid(before_image_json)),
  content_hash      TEXT,
  conflict_state    TEXT NOT NULL DEFAULT 'none' CHECK (conflict_state IN ('none', 'changed_after_import', 'resolved')),
  rolled_back_at    TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX import_ref_run_external ON import_ref (import_run_id, entity_type, external_ref);
CREATE INDEX import_ref_entity ON import_ref (org_id, entity_type, entity_id);
CREATE INDEX import_ref_external ON import_ref (org_id, entity_type, external_ref);

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
CREATE INDEX webhook_delivery_source ON webhook_delivery (source_id);
CREATE INDEX webhook_delivery_received ON webhook_delivery (received_at);
