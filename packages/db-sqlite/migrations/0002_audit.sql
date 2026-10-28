CREATE TABLE audit_chain (
  org_id                TEXT NOT NULL PRIMARY KEY REFERENCES organization (id),
  chain_id              TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  epoch                 INTEGER NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991),
  incarnation           INTEGER NOT NULL DEFAULT 0 CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  head_seq              INTEGER NOT NULL DEFAULT 0 CHECK (head_seq BETWEEN 0 AND 9007199254740991),
  head_hash             TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(head_hash) = 64),
  boundary_seq          INTEGER NOT NULL DEFAULT 1 CHECK (boundary_seq BETWEEN 1 AND 9007199254740991),
  boundary_prev_hash    TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(boundary_prev_hash) = 64),
  boundary_reason       TEXT,
  mode                  TEXT NOT NULL DEFAULT 'trail' CHECK (mode IN ('trail', 'export', 'none')),
  mode_generation       INTEGER NOT NULL DEFAULT 0 CHECK (mode_generation BETWEEN 0 AND 9007199254740991),
  policy                TEXT NOT NULL DEFAULT 'availability' CHECK (policy IN ('availability', 'required')),
  pending_mode          TEXT CHECK (pending_mode IN ('trail', 'export', 'none')),
  cutover_seq           INTEGER CHECK (cutover_seq BETWEEN 0 AND 9007199254740991),
  capacity_state        TEXT NOT NULL DEFAULT 'ok' CHECK (capacity_state IN ('ok', 'warning', 'refusing')),
  journal_rows          INTEGER NOT NULL DEFAULT 0 CHECK (journal_rows >= 0),
  journal_bytes         INTEGER NOT NULL DEFAULT 0 CHECK (journal_bytes >= 0),
  restore_pending       INTEGER NOT NULL DEFAULT 0 CHECK (restore_pending IN (0, 1)),
  verified_from_seq     INTEGER CHECK (verified_from_seq BETWEEN 1 AND 9007199254740991),
  verified_through_seq  INTEGER CHECK (verified_through_seq BETWEEN 0 AND 9007199254740991),
  verified_bodies       INTEGER CHECK (verified_bodies >= 0),
  verified_withheld     INTEGER CHECK (verified_withheld >= 0),
  verified_at           TEXT
) STRICT;

CREATE TABLE audit_sink (
  org_id                TEXT NOT NULL REFERENCES organization (id),
  sink_id               TEXT NOT NULL CHECK (length(sink_id) BETWEEN 1 AND 32 AND sink_id NOT GLOB '*[^a-z0-9-]*'),
  plugin_id             TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32 AND kind NOT GLOB '*[^a-z0-9-]*'),
  generation            INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  receiver_fingerprint  TEXT NOT NULL,
  durable_ack           INTEGER NOT NULL CHECK (durable_ack IN (0, 1)),
  activation_source     TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('active', 'inactive', 'blocked', 'disabled', 'retired')),
  progress_seq          INTEGER NOT NULL CHECK (progress_seq BETWEEN 0 AND 9007199254740991),
  progress_hash         TEXT NOT NULL CHECK (length(progress_hash) = 64),
  custody_seq           INTEGER NOT NULL CHECK (custody_seq BETWEEN 0 AND progress_seq),
  inflight_from         INTEGER CHECK (inflight_from BETWEEN 0 AND 9007199254740991),
  inflight_to           INTEGER CHECK (inflight_to BETWEEN COALESCE(inflight_from, 0) AND 9007199254740991),
  inflight_body         TEXT CHECK (json_valid(inflight_body) AND length(CAST(inflight_body AS BLOB)) <= 524288),
  inflight_repr         TEXT CHECK (json_valid(inflight_repr)),
  next_attempt_at       TEXT,
  attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  retry_count_for_seq   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count_for_seq >= 0),
  blocked_reason        TEXT,
  last_error_code       TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, sink_id)
) STRICT;

CREATE TABLE audit_ledger (
  org_id           TEXT NOT NULL REFERENCES organization (id),
  id               TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('skipped', 'uncertain', 'gap', 'withheld', 'mode_change', 'policy_change', 'cutover', 'rebind', 'retire', 'unblock', 'restore_confirmed', 'export')),
  chain_id         TEXT NOT NULL,
  epoch            INTEGER NOT NULL CHECK (epoch BETWEEN 0 AND 9007199254740991),
  from_seq         INTEGER NOT NULL CHECK (from_seq BETWEEN 0 AND 9007199254740991),
  to_seq           INTEGER NOT NULL CHECK (to_seq BETWEEN from_seq AND 9007199254740991),
  count            INTEGER NOT NULL CHECK (count >= 0),
  sink_id          TEXT,
  reason_code      TEXT NOT NULL,
  policy           TEXT NOT NULL CHECK (policy IN ('availability', 'required')),
  mode_generation  INTEGER NOT NULL CHECK (mode_generation BETWEEN 0 AND 9007199254740991),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('user', 'service_principal', 'customer', 'system')),
  actor_id         TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, id)
) STRICT;

CREATE INDEX audit_sink_state ON audit_sink (org_id, state);
CREATE INDEX audit_ledger_range ON audit_ledger (org_id, from_seq, to_seq);
CREATE INDEX audit_ledger_sink ON audit_ledger (org_id, sink_id, from_seq);

INSERT INTO audit_chain (org_id, head_seq, head_hash, boundary_seq, boundary_prev_hash, journal_rows, journal_bytes)
SELECT o.id,
  COALESCE((SELECT e.seq FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq DESC LIMIT 1), 0),
  COALESCE((SELECT e.hash FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000'),
  COALESCE((SELECT e.seq FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq LIMIT 1), 1),
  COALESCE((SELECT e.prev_hash FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000'),
  (SELECT count(*) FROM audit_event e WHERE e.org_id = o.id),
  COALESCE((SELECT sum(length(CAST(json_object(
    'id', e.id, 'org_id', e.org_id, 'seq', e.seq, 'prev_hash', e.prev_hash, 'hash', e.hash,
    'created_at', e.created_at, 'actor_type', e.actor_type, 'actor_id', e.actor_id,
    'token_selector', e.token_selector, 'source_ip', e.source_ip, 'action', e.action,
    'target_type', e.target_type, 'target_id', e.target_id, 'project_id', e.project_id,
    'payload_json', e.payload_json
  ) AS BLOB))) FROM audit_event e WHERE e.org_id = o.id), 0)
FROM organization o;
