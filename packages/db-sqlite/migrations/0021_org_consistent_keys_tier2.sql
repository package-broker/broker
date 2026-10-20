-- pb:phase contract
-- Package Broker 2.0, migration 0021. SQLite dialect (Cloudflare D1, better-sqlite3, node:sqlite).
-- Composite (org_id, id) foreign keys, tier 2: dist_tag_history, version and registered_name (see 0020 for tier 1).
-- The preflight of 0020 is repeated for the tier 2 references, because rows can change between the two migrations.
-- version is the largest table, so it is copied aside and refilled in eight slices of rowid, keeping every statement short.

SELECT json_extract('{}', '$ dist_tag_history.package_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c JOIN package p ON p.id = c.package_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.version_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c JOIN version p ON p.id = c.version_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.previous_version_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c JOIN version p ON p.id = c.previous_version_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ version.package_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM version c JOIN package p ON p.id = c.package_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ registered_name.source_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM registered_name c JOIN source p ON p.id = c.source_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.package_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c LEFT JOIN package p ON p.id = c.package_id WHERE c.package_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.version_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c LEFT JOIN version p ON p.id = c.version_id WHERE c.version_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.previous_version_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c LEFT JOIN version p ON p.id = c.previous_version_id WHERE c.previous_version_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ version.package_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM version c LEFT JOIN package p ON p.id = c.package_id WHERE c.package_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ registered_name.source_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM registered_name c LEFT JOIN source p ON p.id = c.source_id WHERE c.source_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;

PRAGMA defer_foreign_keys = ON;

CREATE TABLE version_0021 AS SELECT * FROM version WHERE 0;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 0;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 1;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 2;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 3;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 4;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 5;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 6;
INSERT INTO version_0021 SELECT * FROM version WHERE ((rowid % 8) + 8) % 8 = 7;
DROP TABLE version;
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
CREATE UNIQUE INDEX version_org_id ON version (id, org_id);
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 0;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 1;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 2;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 3;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 4;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 5;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 6;
INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp)
  SELECT id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, upstream_released_at, license, blob_id, dist_type, composer_shasum, npm_integrity, source_ref, metadata_json, deprecated_message, status, removed_upstream_at, tombstoned_at, tombstone_reason, purge_after, revision, last_op_id, created_at, updated_at, listing_seen_stamp
  FROM version_0021 WHERE ((rowid % 8) + 8) % 8 = 7;
DROP TABLE version_0021;
CREATE INDEX version_blob ON version (blob_id);
CREATE INDEX version_by_published ON version (package_id, published_at);
CREATE UNIQUE INDEX version_identity ON version (package_id, version_normalized);
CREATE INDEX version_op ON version (last_op_id) WHERE last_op_id IS NOT NULL;
CREATE INDEX version_purge ON version (purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE dist_tag_history_0021 (
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
INSERT INTO dist_tag_history_0021 (id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type, actor_id, op_id, created_at)
  SELECT id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type, actor_id, op_id, created_at FROM dist_tag_history;
DROP TABLE dist_tag_history;
ALTER TABLE dist_tag_history_0021 RENAME TO dist_tag_history;
CREATE INDEX dist_tag_history_previous ON dist_tag_history (previous_version_id);
CREATE INDEX dist_tag_history_tag ON dist_tag_history (package_id, tag, created_at);
CREATE INDEX dist_tag_history_version ON dist_tag_history (version_id);

CREATE TABLE registered_name_0021 (
  id         TEXT NOT NULL PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization (id),
  source_id  TEXT NOT NULL,
  ecosystem  TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  pattern    TEXT NOT NULL CHECK (pattern = lower(pattern)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id) ON DELETE CASCADE
) STRICT;
INSERT INTO registered_name_0021 (id, org_id, source_id, ecosystem, pattern, created_at)
  SELECT id, org_id, source_id, ecosystem, pattern, created_at FROM registered_name;
DROP TABLE registered_name;
ALTER TABLE registered_name_0021 RENAME TO registered_name;
CREATE UNIQUE INDEX registered_name_pattern ON registered_name (org_id, ecosystem, pattern);
CREATE INDEX registered_name_source ON registered_name (source_id);
