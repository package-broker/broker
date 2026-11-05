-- pb:phase expand

ALTER TABLE source ADD COLUMN require_publish_approval INTEGER NOT NULL DEFAULT 0 CONSTRAINT source_publish_approval CHECK (require_publish_approval IN (0, 1));
ALTER TABLE package ADD COLUMN new_project_access_mode TEXT NOT NULL DEFAULT 'none' CONSTRAINT package_access_mode CHECK (new_project_access_mode IN ('none', 'request'));
ALTER TABLE package ADD COLUMN held_until_active INTEGER NOT NULL DEFAULT 0 CONSTRAINT package_held CHECK (held_until_active IN (0, 1));

CREATE UNIQUE INDEX user_account_org_id ON user_account (id, org_id);

CREATE TABLE publish_approval (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  package_id TEXT NOT NULL,
  version_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  hold_approval INTEGER NOT NULL CONSTRAINT publish_hold_approval CHECK (hold_approval IN (0, 1)),
  hold_scan INTEGER NOT NULL CONSTRAINT publish_hold_scan CHECK (hold_scan IN (0, 1)),
  approval_state TEXT NOT NULL CONSTRAINT publish_approval_state CHECK (approval_state IN ('not_required', 'pending', 'approved', 'rejected', 'expired')),
  scan_state TEXT NOT NULL CONSTRAINT publish_scan_state CHECK (scan_state IN ('not_required', 'queued', 'running', 'allowed', 'denied', 'failed')),
  required_scanners_json TEXT NOT NULL DEFAULT '[]' CONSTRAINT publish_scanners_json CHECK (json_valid(required_scanners_json)),
  scan_attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT publish_attempts CHECK (scan_attempts >= 0),
  requested_by_type TEXT NOT NULL CONSTRAINT publish_requester_type CHECK (requested_by_type IN ('user', 'service')),
  requested_by_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  route_project_id TEXT,
  dist_tags_json TEXT NOT NULL DEFAULT '{}' CONSTRAINT publish_tags_json CHECK (json_valid(dist_tags_json)),
  readme_pending INTEGER NOT NULL DEFAULT 0 CONSTRAINT publish_readme_pending CHECK (readme_pending IN (0, 1)),
  decided_by_user_id TEXT,
  decided_at TEXT,
  decision_reason TEXT CONSTRAINT publish_reason_bytes CHECK (decision_reason IS NULL OR length(CAST(decision_reason AS BLOB)) <= 1000),
  scan_verdict_json TEXT NOT NULL DEFAULT '[]' CONSTRAINT publish_verdict_json CHECK (json_valid(scan_verdict_json)),
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT publish_revision CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT publish_approval_hold CHECK ((hold_approval = 0) = (approval_state = 'not_required')),
  CONSTRAINT publish_scan_hold CHECK ((hold_scan = 0) = (scan_state = 'not_required')),
  CONSTRAINT publish_decision_time CHECK ((decided_at IS NOT NULL) = (approval_state IN ('approved', 'rejected', 'expired'))),
  CONSTRAINT publish_decision_actor CHECK (approval_state NOT IN ('approved', 'rejected') OR decided_by_user_id IS NOT NULL),
  CONSTRAINT publish_expiry_actor CHECK (approval_state <> 'expired' OR decided_by_user_id IS NULL),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id),
  FOREIGN KEY (org_id, version_id) REFERENCES version (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES source (org_id, id),
  FOREIGN KEY (org_id, route_project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, decided_by_user_id) REFERENCES user_account (org_id, id)
) STRICT;

CREATE INDEX publish_approval_package ON publish_approval (org_id, package_id);
CREATE INDEX publish_approval_list ON publish_approval (org_id, approval_state, id);
CREATE INDEX publish_approval_expiry ON publish_approval (org_id, expires_at, id) WHERE approval_state = 'pending';
CREATE INDEX publish_approval_scan ON publish_approval (org_id, scan_state, updated_at, id);

CREATE TABLE package_access_request (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  package_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT access_state CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  requested_by_user_id TEXT NOT NULL,
  reason TEXT CONSTRAINT access_reason_bytes CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) <= 1000) CONSTRAINT access_reason_controls CHECK (reason IS NULL OR (instr(reason, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), reason) = 0)),
  decided_by_user_id TEXT,
  decided_at TEXT,
  decision_reason TEXT CONSTRAINT access_decision_reason_bytes CHECK (decision_reason IS NULL OR length(CAST(decision_reason AS BLOB)) <= 1000) CONSTRAINT access_decision_reason_controls CHECK (decision_reason IS NULL OR (instr(decision_reason, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), decision_reason) = 0)),
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT access_revision CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  CONSTRAINT access_decision_actor CHECK (state NOT IN ('approved', 'rejected') OR decided_by_user_id IS NOT NULL),
  CONSTRAINT access_expiry_actor CHECK (state <> 'expired' OR decided_by_user_id IS NULL),
  CONSTRAINT access_decision_time CHECK ((decided_at IS NOT NULL) = (state IN ('approved', 'rejected', 'expired'))),
  FOREIGN KEY (org_id, requested_by_user_id) REFERENCES user_account (org_id, id),
  FOREIGN KEY (org_id, decided_by_user_id) REFERENCES user_account (org_id, id)
) STRICT;

CREATE UNIQUE INDEX package_access_request_pending ON package_access_request (package_id, project_id) WHERE state = 'pending';
CREATE INDEX package_access_request_list ON package_access_request (org_id, state, id);
CREATE INDEX package_access_request_expiry ON package_access_request (org_id, expires_at, id) WHERE state = 'pending';

CREATE TABLE version_readme (
  version_id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  filename TEXT NOT NULL,
  body TEXT NOT NULL CONSTRAINT readme_body_bytes CHECK (length(CAST(body AS BLOB)) <= 524288),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT readme_controls CHECK (instr(body, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), body) = 0),
  FOREIGN KEY (org_id, version_id) REFERENCES version (org_id, id) ON DELETE CASCADE
) STRICT;
