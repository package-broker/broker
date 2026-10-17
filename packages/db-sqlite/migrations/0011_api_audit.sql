-- pb:phase expand

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
CREATE INDEX audit_pending_org_id ON audit_pending (org_id, id);

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
CREATE INDEX api_idempotency_expiry ON api_idempotency (org_id, expires_at);

CREATE INDEX audit_event_action ON audit_event (org_id, action, seq);
