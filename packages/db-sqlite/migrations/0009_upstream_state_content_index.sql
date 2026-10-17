CREATE INDEX upstream_state_content ON upstream_state (org_id, content_sha256);
CREATE INDEX ingest_session_snapshot_blob ON ingest_session (org_id, snapshot_blob_sha256);

ALTER TABLE blob ADD COLUMN published_at TEXT;
UPDATE blob SET published_at = created_at;
