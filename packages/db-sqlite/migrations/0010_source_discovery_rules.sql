-- pb:phase expand

CREATE UNIQUE INDEX credential_discovery_scope ON credential (org_id, id);

CREATE TABLE source_discovery_rule (
  org_id TEXT NOT NULL REFERENCES organization (id),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = trim(name) AND name NOT GLOB '*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*' AND instr(name,char(0))=0),
  credential_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL CHECK (installation_id BETWEEN 1 AND 9007199254740991),
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm', 'both')),
  repository_pattern TEXT NOT NULL CHECK (length(repository_pattern) BETWEEN 1 AND 100 AND repository_pattern NOT GLOB '*[^A-Za-z0-9._*?-]*'),
  include_forks INTEGER NOT NULL DEFAULT 0 CHECK (include_forks IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  rescan_interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (rescan_interval_seconds BETWEEN 3600 AND 2592000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_outcome TEXT CHECK (last_run_outcome IN ('running', 'succeeded', 'failed', 'rate_limited')),
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  existing_count INTEGER NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skip_details_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skip_details_json) AND json_type(skip_details_json) = 'array' AND json_array_length(skip_details_json) <= 50 AND length(skip_details_json) <= 16384),
  pending_results_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_results_json) AND json_type(pending_results_json)='array' AND json_array_length(pending_results_json)<=2 AND length(pending_results_json)<=16384),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 5),
  failure_reason TEXT,
  completed_json TEXT CHECK (completed_json IS NULL OR (json_valid(completed_json) AND length(completed_json) <= 20000)),
  plan_cursor TEXT CHECK (plan_cursor IS NULL OR (length(plan_cursor) BETWEEN 1 AND 6 AND plan_cursor NOT GLOB '*[^0-9]*' AND substr(plan_cursor, 1, 1) <> '0')),
  remaining_repositories_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(remaining_repositories_json) AND json_type(remaining_repositories_json) = 'array' AND json_array_length(remaining_repositories_json) <= 49 AND length(remaining_repositories_json) <= 8192),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, name),
  FOREIGN KEY (org_id, credential_id) REFERENCES credential (org_id, id)
) STRICT;

CREATE INDEX source_discovery_rule_due ON source_discovery_rule (org_id, enabled, next_run_at, id);

CREATE TABLE source_discovery_admission (
  org_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  run_started_at TEXT,
  PRIMARY KEY (org_id, source_id),
  FOREIGN KEY (org_id, rule_id) REFERENCES source_discovery_rule (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, org_id) REFERENCES source (id, org_id) ON DELETE CASCADE
) STRICT;
