CREATE TABLE audit_chain (
  org_id                TEXT NOT NULL PRIMARY KEY REFERENCES organization (id),
  chain_id              TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) CHECK (length(chain_id) = 32 AND chain_id NOT GLOB '*[^0-9a-f]*'),
  epoch                 INTEGER NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991),
  incarnation           INTEGER NOT NULL DEFAULT 0 CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  head_seq              INTEGER NOT NULL DEFAULT 0 CHECK (head_seq BETWEEN 0 AND 9007199254740991),
  head_hash             TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(head_hash) = 64),
  boundary_seq          INTEGER NOT NULL DEFAULT 1 CHECK (boundary_seq BETWEEN 1 AND 9007199254740991),
  boundary_prev_hash    TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(boundary_prev_hash) = 64),
  boundary_reason       TEXT CHECK (boundary_reason IN ('backfill', 'prune', 'capacity', 'chain_reset', 'epoch_bump')),
  mode                  TEXT NOT NULL DEFAULT 'trail' CHECK (mode IN ('trail', 'export', 'none')),
  mode_generation       INTEGER NOT NULL DEFAULT 0 CHECK (mode_generation BETWEEN 0 AND 9007199254740991),
  policy                TEXT NOT NULL DEFAULT 'availability' CHECK (policy IN ('availability', 'required')),
  pending_mode          TEXT CHECK (pending_mode IN ('trail', 'export', 'none')),
  cutover_seq           INTEGER CHECK (cutover_seq BETWEEN 0 AND 9007199254740991),
  capacity_state        TEXT NOT NULL DEFAULT 'ok' CHECK (capacity_state IN ('ok', 'warning', 'refusing')),
  capacity_evict_to     INTEGER CHECK (capacity_evict_to BETWEEN 0 AND 9007199254740991),
  journal_rows          INTEGER NOT NULL DEFAULT 0 CHECK (journal_rows >= 0),
  journal_bytes         INTEGER NOT NULL DEFAULT 0 CHECK (journal_bytes >= 0),
  restore_pending       INTEGER NOT NULL DEFAULT 0 CHECK (restore_pending IN (0, 1)),
  integrity_incidents   INTEGER NOT NULL DEFAULT 0 CHECK (integrity_incidents BETWEEN 0 AND 9007199254740991),
  verified_from_seq     INTEGER CHECK (verified_from_seq BETWEEN 1 AND 9007199254740991),
  verified_through_seq  INTEGER CHECK (verified_through_seq BETWEEN 0 AND 9007199254740991),
  verified_bodies       INTEGER CHECK (verified_bodies >= 0),
  verified_withheld     INTEGER CHECK (verified_withheld >= 0),
  verified_at           TEXT
) STRICT;

CREATE TABLE audit_sink (
  org_id                TEXT NOT NULL,
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
  custody_seq           INTEGER NOT NULL CHECK (custody_seq BETWEEN 0 AND 9007199254740991),
  inflight_from         INTEGER CHECK (inflight_from BETWEEN 1 AND 9007199254740991),
  inflight_to           INTEGER CHECK (inflight_to BETWEEN COALESCE(inflight_from, 0) AND 9007199254740991),
  inflight_body         TEXT CHECK (json_valid(inflight_body) AND length(CAST(inflight_body AS BLOB)) <= 524288),
  inflight_repr         TEXT CHECK (json_valid(inflight_repr)),
  next_attempt_at       TEXT,
  attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  retry_count_for_seq   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count_for_seq >= 0),
  body_version          INTEGER NOT NULL DEFAULT 0 CHECK (body_version BETWEEN 0 AND 9007199254740991),
  blocked_reason        TEXT,
  last_error_code       TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, sink_id),
  FOREIGN KEY (org_id) REFERENCES audit_chain (org_id),
  CHECK ((inflight_from IS NULL) = (inflight_to IS NULL)),
  CHECK (inflight_body IS NULL OR inflight_from IS NOT NULL)
) STRICT;

CREATE TRIGGER audit_sink_body_version_monotonic
BEFORE UPDATE OF body_version ON audit_sink
WHEN NEW.body_version < OLD.body_version
BEGIN
  SELECT RAISE(ABORT, 'audit sink body version is monotonic');
END;

CREATE TRIGGER audit_sink_body_version_bump
AFTER UPDATE OF inflight_body, inflight_repr ON audit_sink
WHEN NEW.body_version = OLD.body_version
  AND (NEW.inflight_body IS NOT OLD.inflight_body OR NEW.inflight_repr IS NOT OLD.inflight_repr)
BEGIN
  UPDATE audit_sink SET body_version = OLD.body_version + 1
  WHERE org_id = NEW.org_id AND sink_id = NEW.sink_id;
END;

CREATE TABLE audit_ledger (
  org_id           TEXT NOT NULL,
  id               TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('skipped', 'uncertain', 'gap', 'withheld', 'mode_change', 'policy_change', 'cutover', 'rebind', 'retire', 'unblock', 'restore_confirmed', 'export', 'replay', 'chain_reset', 'epoch_bump')),
  chain_id         TEXT NOT NULL CHECK (length(chain_id) = 32 AND chain_id NOT GLOB '*[^0-9a-f]*'),
  epoch            INTEGER NOT NULL CHECK (epoch BETWEEN 0 AND 9007199254740991),
  from_seq         INTEGER NOT NULL CHECK (from_seq BETWEEN 1 AND 9007199254740991),
  to_seq           INTEGER NOT NULL CHECK (to_seq BETWEEN from_seq AND 9007199254740991),
  count            INTEGER NOT NULL CHECK (count >= 0),
  sink_id          TEXT CHECK (sink_id IS NULL OR (length(sink_id) BETWEEN 1 AND 32 AND sink_id NOT GLOB '*[^a-z0-9-]*')),
  reason_code      TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 32 AND substr(reason_code, 1, 1) GLOB '[a-z]' AND reason_code NOT GLOB '*[^a-z_]*'),
  policy           TEXT NOT NULL CHECK (policy IN ('availability', 'required')),
  mode_generation  INTEGER NOT NULL CHECK (mode_generation BETWEEN 0 AND 9007199254740991),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('user', 'service_principal', 'customer', 'system')),
  actor_id         TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  superseded_by    TEXT,
  resolves_id      TEXT,
  capacity_json    TEXT CHECK (capacity_json IS NULL OR (json_valid(capacity_json) AND length(CAST(capacity_json AS BLOB)) <= 65536)),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id) REFERENCES organization (id),
  FOREIGN KEY (org_id, sink_id) REFERENCES audit_sink (org_id, sink_id),
  CHECK (superseded_by IS NULL OR (kind = 'gap' AND superseded_by <> id))
) STRICT;

CREATE TRIGGER audit_ledger_append_only_update
BEFORE UPDATE ON audit_ledger
WHEN NOT (
  OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL
  AND NEW.org_id = OLD.org_id AND NEW.id = OLD.id AND NEW.kind = OLD.kind
  AND NEW.chain_id = OLD.chain_id AND NEW.epoch = OLD.epoch
  AND NEW.from_seq = OLD.from_seq AND NEW.to_seq = OLD.to_seq AND NEW.count = OLD.count
  AND NEW.sink_id IS OLD.sink_id AND NEW.reason_code = OLD.reason_code AND NEW.policy = OLD.policy
  AND NEW.mode_generation = OLD.mode_generation AND NEW.actor_type = OLD.actor_type
  AND NEW.resolves_id IS OLD.resolves_id AND NEW.capacity_json IS OLD.capacity_json
  AND NEW.actor_id IS OLD.actor_id AND NEW.created_at = OLD.created_at
  AND EXISTS (
    SELECT 1 FROM audit_ledger AS covering
    WHERE covering.org_id = OLD.org_id AND covering.id = NEW.superseded_by
      AND covering.kind = 'gap' AND covering.superseded_by IS NULL
      AND covering.chain_id = OLD.chain_id AND covering.epoch = OLD.epoch
      AND covering.reason_code = OLD.reason_code AND covering.sink_id IS OLD.sink_id
      AND (covering.capacity_json IS OLD.capacity_json OR (
        covering.capacity_json IS NOT NULL AND OLD.capacity_json IS NOT NULL
        AND (covering.from_seq < OLD.from_seq OR json_extract(covering.capacity_json, '$.prevHash') = json_extract(OLD.capacity_json, '$.prevHash'))
        AND (covering.to_seq > OLD.to_seq OR json_extract(covering.capacity_json, '$.hash') = json_extract(OLD.capacity_json, '$.hash'))
        AND (json_extract(covering.capacity_json, '$.affectedSinkIdsOverflow') = 1 OR NOT EXISTS (
          SELECT 1 FROM json_each(OLD.capacity_json, '$.affectedSinkIds') old_sink
          WHERE old_sink.value NOT IN (SELECT value FROM json_each(covering.capacity_json, '$.affectedSinkIds'))))
      ))
      AND covering.from_seq <= OLD.from_seq AND covering.to_seq >= OLD.to_seq
      AND covering.to_seq - covering.from_seq > OLD.to_seq - OLD.from_seq
      AND covering.count >= OLD.count + COALESCE((
        SELECT sum(hidden.count) FROM audit_ledger AS hidden
        WHERE hidden.org_id = OLD.org_id AND hidden.superseded_by = NEW.superseded_by
      ), 0)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'audit ledger is append-only');
END;

CREATE TRIGGER audit_ledger_insert_visible
BEFORE INSERT ON audit_ledger
WHEN NEW.superseded_by IS NOT NULL OR (
  NEW.resolves_id IS NOT NULL AND (
    NEW.kind <> 'replay' OR NOT EXISTS (
      SELECT 1 FROM audit_ledger AS resolved
      WHERE resolved.org_id = NEW.org_id AND resolved.id = NEW.resolves_id
        AND resolved.kind IN ('uncertain', 'withheld') AND resolved.chain_id = NEW.chain_id
        AND resolved.epoch = NEW.epoch AND NEW.sink_id IS NOT NULL
        AND (resolved.sink_id IS NULL OR resolved.sink_id IS NEW.sink_id)
        AND NEW.from_seq <= resolved.from_seq AND NEW.to_seq >= resolved.to_seq
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'audit ledger rows are inserted visible');
END;

CREATE TRIGGER audit_ledger_capacity_insert
BEFORE INSERT ON audit_ledger
WHEN NEW.capacity_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.kind <> 'gap' OR NEW.reason_code <> 'capacity' OR NEW.sink_id IS NOT NULL
    OR json_type(NEW.capacity_json) IS NOT 'object'
    OR json_type(NEW.capacity_json, '$.prevHash') IS NOT 'text'
    OR length(json_extract(NEW.capacity_json, '$.prevHash')) <> 64
    OR json_extract(NEW.capacity_json, '$.prevHash') GLOB '*[^0-9a-f]*'
    OR json_type(NEW.capacity_json, '$.hash') IS NOT 'text'
    OR length(json_extract(NEW.capacity_json, '$.hash')) <> 64
    OR json_extract(NEW.capacity_json, '$.hash') GLOB '*[^0-9a-f]*'
    OR EXISTS (SELECT 1 FROM json_each(NEW.capacity_json)
      WHERE key NOT IN ('prevHash', 'hash', 'affectedSinkIds', 'affectedSinkIdsOverflow'))
    OR (SELECT count(*) FROM json_each(NEW.capacity_json)) <> CASE
      WHEN json_type(NEW.capacity_json, '$.affectedSinkIdsOverflow') IS NULL THEN 3 ELSE 4 END
    OR (json_type(NEW.capacity_json, '$.affectedSinkIdsOverflow') IS NOT NULL
      AND json_type(NEW.capacity_json, '$.affectedSinkIdsOverflow') IS NOT 'true')
    OR json_type(NEW.capacity_json, '$.affectedSinkIds') IS NOT 'array'
    OR json_array_length(NEW.capacity_json, '$.affectedSinkIds') > 1000
    OR EXISTS (SELECT 1 FROM json_each(NEW.capacity_json, '$.affectedSinkIds') s
      WHERE s.type <> 'text' OR length(s.value) NOT BETWEEN 1 AND 32
        OR s.value GLOB '*[^a-z0-9-]*'
        OR (CAST(s.key AS INTEGER) > 0 AND s.value <= json_extract(NEW.capacity_json,
          '$.affectedSinkIds[' || (CAST(s.key AS INTEGER) - 1) || ']')))
    THEN RAISE(ABORT, 'invalid audit capacity metadata') END;
END;

CREATE TRIGGER audit_ledger_append_only_delete
BEFORE DELETE ON audit_ledger
BEGIN
  SELECT RAISE(ABORT, 'audit ledger is append-only');
END;

CREATE INDEX audit_sink_state ON audit_sink (org_id, state);
CREATE INDEX audit_ledger_range ON audit_ledger (org_id, from_seq, to_seq);
CREATE INDEX audit_ledger_sink ON audit_ledger (org_id, sink_id, from_seq);
CREATE INDEX audit_ledger_open_gap ON audit_ledger (org_id, chain_id, epoch, reason_code, sink_id, from_seq, id) WHERE kind = 'gap' AND superseded_by IS NULL;
CREATE INDEX audit_ledger_visible ON audit_ledger (org_id, id) WHERE superseded_by IS NULL;
CREATE INDEX audit_ledger_superseded ON audit_ledger (org_id, superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX audit_ledger_kind_chain ON audit_ledger (org_id, kind, chain_id, epoch, created_at, id) WHERE superseded_by IS NULL;
CREATE INDEX audit_ledger_reset ON audit_ledger (org_id, chain_id, created_at, id) WHERE kind = 'chain_reset' AND superseded_by IS NULL;
CREATE INDEX audit_ledger_resolves ON audit_ledger (org_id, resolves_id) WHERE resolves_id IS NOT NULL;

INSERT INTO audit_chain (org_id, head_seq, head_hash, boundary_seq, boundary_prev_hash, boundary_reason, journal_rows, journal_bytes)
SELECT o.id,
  COALESCE((SELECT e.seq FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq DESC LIMIT 1), 0),
  COALESCE((SELECT e.hash FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000'),
  COALESCE((SELECT e.seq FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq LIMIT 1), 1),
  COALESCE((SELECT e.prev_hash FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000'),
  CASE WHEN COALESCE((SELECT e.seq FROM audit_event e WHERE e.org_id = o.id ORDER BY e.seq LIMIT 1), 1) > 1 THEN 'backfill' END,
  (SELECT count(*) FROM audit_event e WHERE e.org_id = o.id),
  COALESCE((SELECT sum(length(CAST(json_object(
    'id', e.id, 'org_id', e.org_id, 'seq', e.seq, 'prev_hash', e.prev_hash, 'hash', e.hash,
    'created_at', e.created_at, 'actor_type', e.actor_type, 'actor_id', e.actor_id,
    'token_selector', e.token_selector, 'source_ip', e.source_ip, 'action', e.action,
    'target_type', e.target_type, 'target_id', e.target_id, 'project_id', e.project_id,
    'payload_json', e.payload_json
  ) AS BLOB))) FROM audit_event e WHERE e.org_id = o.id), 0)
FROM organization o;

CREATE TRIGGER organization_audit_chain
AFTER INSERT ON organization
BEGIN
  INSERT INTO audit_chain (org_id) VALUES (NEW.id);
END;
