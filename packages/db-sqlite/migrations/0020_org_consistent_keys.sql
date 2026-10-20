-- pb:phase contract
-- Package Broker 2.0, migration 0020. SQLite dialect (Cloudflare D1, better-sqlite3, node:sqlite).
-- Composite (org_id, id) foreign keys, tier 1: a child row can no longer reference a parent of another organization.
-- Tier 2 (dist_tag_history, version, registered_name) is migration 0021.
-- The preflight runs first and covers both tiers. json_extract on a malformed path is the only way plain SQL can abort
-- a batch with a message that carries data: the error text is "bad JSON path: '$ <table>.<column> cross-org rows: <count>'"
-- (or "orphan rows" for a child row whose parent does not exist).
-- package is copied aside, dropped, recreated and refilled from the copy: with foreign key checks deferred, only rows
-- inserted into the recreated parent clear the violations the drop raised.
-- The parent keys are unique indexes on (id, org_id): SQLite matches a parent key by column set, and with org_id
-- second the planner cannot pick them for org_id-only predicates over the existing indexes.
-- upstream_state is copied aside and restored because dropping package cascades into it.

SELECT json_extract('{}', '$ dist_tag.package_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag c JOIN package p ON p.id = c.package_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag.version_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag c JOIN version p ON p.id = c.version_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.package_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c JOIN package p ON p.id = c.package_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.version_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c JOIN version p ON p.id = c.version_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.previous_version_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c JOIN version p ON p.id = c.previous_version_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ project_package.project_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM project_package c JOIN project p ON p.id = c.project_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ project_package.package_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM project_package c JOIN package p ON p.id = c.package_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ project_package_pattern.project_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM project_package_pattern c JOIN project p ON p.id = c.project_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ project_package_pattern.source_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM project_package_pattern c JOIN source p ON p.id = c.source_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ project_source.project_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM project_source c JOIN project p ON p.id = c.project_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ project_source.source_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM project_source c JOIN source p ON p.id = c.source_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ package.source_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM package c JOIN source p ON p.id = c.source_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ version.package_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM version c JOIN package p ON p.id = c.package_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ registered_name.source_id cross-org rows: ' || n) FROM (SELECT count(*) AS n FROM registered_name c JOIN source p ON p.id = c.source_id WHERE c.org_id <> p.org_id) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag.package_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag c LEFT JOIN package p ON p.id = c.package_id WHERE c.package_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag.version_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag c LEFT JOIN version p ON p.id = c.version_id WHERE c.version_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.package_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c LEFT JOIN package p ON p.id = c.package_id WHERE c.package_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.version_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c LEFT JOIN version p ON p.id = c.version_id WHERE c.version_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ dist_tag_history.previous_version_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM dist_tag_history c LEFT JOIN version p ON p.id = c.previous_version_id WHERE c.previous_version_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ project_package.project_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM project_package c LEFT JOIN project p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ project_package.package_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM project_package c LEFT JOIN package p ON p.id = c.package_id WHERE c.package_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ project_package_pattern.project_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM project_package_pattern c LEFT JOIN project p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ project_package_pattern.source_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM project_package_pattern c LEFT JOIN source p ON p.id = c.source_id WHERE c.source_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ project_source.project_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM project_source c LEFT JOIN project p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ project_source.source_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM project_source c LEFT JOIN source p ON p.id = c.source_id WHERE c.source_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ package.source_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM package c LEFT JOIN source p ON p.id = c.source_id WHERE c.source_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ version.package_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM version c LEFT JOIN package p ON p.id = c.package_id WHERE c.package_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;
SELECT json_extract('{}', '$ registered_name.source_id orphan rows: ' || n) FROM (SELECT count(*) AS n FROM registered_name c LEFT JOIN source p ON p.id = c.source_id WHERE c.source_id IS NOT NULL AND p.id IS NULL) WHERE n > 0;

PRAGMA defer_foreign_keys = ON;

CREATE UNIQUE INDEX source_org_id ON source (id, org_id);
CREATE UNIQUE INDEX project_org_id ON project (id, org_id);
CREATE UNIQUE INDEX version_org_id ON version (id, org_id);

CREATE TABLE upstream_state_0020 AS SELECT * FROM upstream_state;
CREATE TABLE package_0020 AS SELECT * FROM package;

DROP TABLE package;
CREATE TABLE package (
  id                         TEXT NOT NULL PRIMARY KEY,
  org_id                     TEXT NOT NULL REFERENCES organization (id),
  source_id                  TEXT NOT NULL,
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
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  removal_cause              TEXT CHECK (removal_cause IS NULL OR removal_cause IN ('document_absent', 'source_listing')),
  last_op_id                 TEXT,
  listing_open_stamp         TEXT,
  listing_seen_stamp         TEXT,
  listing_opened_at          TEXT,
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id)
) STRICT;
INSERT INTO package (id, org_id, source_id, ecosystem, name, description, visible_to_new_projects, status, removed_upstream_at, rev, modified_at, last_synced_at, created_at, updated_at, removal_cause, last_op_id, listing_open_stamp, listing_seen_stamp, listing_opened_at)
  SELECT id, org_id, source_id, ecosystem, name, description, visible_to_new_projects, status, removed_upstream_at, rev, modified_at, last_synced_at, created_at, updated_at, removal_cause, last_op_id, listing_open_stamp, listing_seen_stamp, listing_opened_at
  FROM package_0020;
DROP TABLE package_0020;
CREATE INDEX package_by_name ON package (org_id, ecosystem, name);
CREATE UNIQUE INDEX package_identity ON package (org_id, ecosystem, source_id, name);
CREATE INDEX package_source ON package (source_id);
CREATE UNIQUE INDEX package_org_id ON package (id, org_id);

DELETE FROM upstream_state;
INSERT INTO upstream_state SELECT * FROM upstream_state_0020;
DROP TABLE upstream_state_0020;

CREATE TABLE dist_tag_0020 (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  package_id TEXT NOT NULL,
  tag        TEXT NOT NULL,
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (package_id, tag),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id),
  FOREIGN KEY (org_id, version_id) REFERENCES version (org_id, id)
) STRICT, WITHOUT ROWID;
INSERT INTO dist_tag_0020 (org_id, package_id, tag, version_id, updated_at)
  SELECT org_id, package_id, tag, version_id, updated_at FROM dist_tag;
DROP TABLE dist_tag;
ALTER TABLE dist_tag_0020 RENAME TO dist_tag;
CREATE INDEX dist_tag_version ON dist_tag (version_id);

CREATE TABLE project_package_0020 (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  origin     TEXT NOT NULL CHECK (origin IN ('subscription', 'explicit', 'pattern')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, package_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id)
) STRICT, WITHOUT ROWID;
INSERT INTO project_package_0020 (org_id, project_id, package_id, origin, created_at)
  SELECT org_id, project_id, package_id, origin, created_at FROM project_package;
DROP TABLE project_package;
ALTER TABLE project_package_0020 RENAME TO project_package;
CREATE INDEX project_package_package ON project_package (package_id);

CREATE TABLE project_package_pattern_0020 (
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
INSERT INTO project_package_pattern_0020 (id, org_id, project_id, source_id, pattern, effect, created_at)
  SELECT id, org_id, project_id, source_id, pattern, effect, created_at FROM project_package_pattern;
DROP TABLE project_package_pattern;
ALTER TABLE project_package_pattern_0020 RENAME TO project_package_pattern;
CREATE UNIQUE INDEX project_package_pattern_identity ON project_package_pattern (project_id, source_id, pattern);
CREATE INDEX project_package_pattern_source ON project_package_pattern (source_id);

CREATE TABLE project_source_0020 (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 100 CHECK (precedence >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, source_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id)
) STRICT, WITHOUT ROWID;
INSERT INTO project_source_0020 (org_id, project_id, source_id, precedence, created_at)
  SELECT org_id, project_id, source_id, precedence, created_at FROM project_source;
DROP TABLE project_source;
ALTER TABLE project_source_0020 RENAME TO project_source;
CREATE INDEX project_source_source ON project_source (source_id);
