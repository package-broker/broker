-- pb:phase expand

CREATE TABLE registry_policy_rule (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT,
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm', 'composer')),
  package_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('min_age', 'block', 'allowlist', 'quarantine', 'client_floor')),
  min_age_seconds INTEGER CHECK (min_age_seconds BETWEEN 0 AND 315360000),
  client_family TEXT CHECK (client_family IN ('npm', 'pnpm', 'yarn', 'composer')),
  client_min_version TEXT,
  deny_unknown INTEGER NOT NULL DEFAULT 0 CHECK (deny_unknown IN (0, 1)),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('malware', 'security_review', 'compatibility', 'organization_policy')),
  incident_id TEXT,
  expires_at TEXT CHECK (expires_at IS NULL OR (length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at)),
  expiry_audited_at TEXT CHECK (expiry_audited_at IS NULL OR (length(expiry_audited_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expiry_audited_at) IS expiry_audited_at)),
  disabled_at TEXT CHECK (disabled_at IS NULL OR (length(disabled_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at) IS disabled_at)),
  disabled_reason TEXT CHECK (disabled_reason IN ('false_positive', 'emergency_compatibility', 'superseded', 'other')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  CHECK ((kind = 'min_age' AND min_age_seconds IS NOT NULL) OR (kind <> 'min_age' AND min_age_seconds IS NULL)),
  CHECK ((kind = 'client_floor' AND client_family IS NOT NULL AND client_min_version IS NOT NULL AND package_key IS NULL) OR (kind <> 'client_floor' AND client_family IS NULL AND client_min_version IS NULL)),
  CHECK (kind = 'client_floor' OR deny_unknown = 0),
  CHECK (kind NOT IN ('block', 'allowlist', 'quarantine') OR package_key IS NOT NULL),
  CHECK (kind <> 'quarantine' OR (project_id IS NULL AND expires_at IS NULL AND reason_code = 'malware')),
  CHECK (client_family IS NULL OR (ecosystem = 'composer' AND client_family = 'composer') OR (ecosystem = 'npm' AND client_family IN ('npm', 'pnpm', 'yarn'))),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL)),
  CHECK (disabled_at IS NULL OR disabled_at >= created_at),
  CHECK (package_key IS NULL OR length(CAST(package_key AS BLOB)) BETWEEN 1 AND 512),
  CHECK (client_min_version IS NULL OR length(client_min_version) BETWEEN 5 AND 64),
  CHECK (incident_id IS NULL OR length(incident_id) = 26)
) STRICT;

CREATE INDEX registry_policy_scope ON registry_policy_rule (org_id, ecosystem, project_id, package_key) WHERE disabled_at IS NULL;
CREATE INDEX registry_policy_expiry ON registry_policy_rule (org_id, expires_at, id) WHERE expires_at IS NOT NULL AND disabled_at IS NULL;

CREATE TABLE registry_policy_version (
  org_id TEXT NOT NULL REFERENCES organization (id),
  rule_id TEXT NOT NULL,
  version_normalized TEXT NOT NULL CHECK (length(CAST(version_normalized AS BLOB)) BETWEEN 1 AND 512),
  PRIMARY KEY (org_id, rule_id, version_normalized),
  FOREIGN KEY (org_id, rule_id) REFERENCES registry_policy_rule (org_id, id)
) STRICT, WITHOUT ROWID;
