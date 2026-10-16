-- Package Broker 2.0, migration 0007. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Registry ingest: ingest sessions, upstream validators, fetch leases and per-project representation clocks.
-- Expand only: adds four tables and their indexes. No triggers, no change to an earlier migration.

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
CREATE UNIQUE INDEX ingest_session_running_scope ON ingest_session (org_id, scope_key) WHERE state = 'running';
CREATE INDEX ingest_session_state_lease ON ingest_session (state, lease_until);
CREATE INDEX ingest_session_scope_generation ON ingest_session (org_id, scope_key, generation);

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

CREATE TABLE fetch_lease (
  org_id      TEXT NOT NULL REFERENCES organization (id),
  lease_key   TEXT NOT NULL PRIMARY KEY CHECK (length(lease_key) = 64 AND lease_key = lower(lease_key) AND lease_key NOT GLOB '*[^0-9a-f]*'),
  owner       TEXT NOT NULL,
  fence       INTEGER NOT NULL CHECK (fence >= 1),
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX fetch_lease_expiry ON fetch_lease (lease_until);

CREATE TABLE representation_clock (
  org_id        TEXT NOT NULL REFERENCES organization (id),
  project_id    TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash = lower(key_hash) AND key_hash NOT GLOB '*[^0-9a-f]*'),
  form          TEXT NOT NULL CHECK (form IN ('composer-p2', 'composer-p2-dev')),
  validator     TEXT NOT NULL CHECK (length(validator) = 64 AND validator = lower(validator) AND validator NOT GLOB '*[^0-9a-f]*'),
  last_modified TEXT NOT NULL,
  PRIMARY KEY (project_id, key_hash, form)
) STRICT, WITHOUT ROWID;
