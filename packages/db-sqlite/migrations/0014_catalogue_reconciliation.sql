-- pb:phase expand
ALTER TABLE package ADD COLUMN removal_cause TEXT
  CHECK (removal_cause IS NULL OR removal_cause IN ('document_absent', 'source_listing'));
ALTER TABLE package ADD COLUMN last_op_id TEXT;
ALTER TABLE source ADD COLUMN listing_open_stamp TEXT;
ALTER TABLE package ADD COLUMN listing_open_stamp TEXT;
ALTER TABLE package ADD COLUMN listing_seen_stamp TEXT;
ALTER TABLE version ADD COLUMN listing_seen_stamp TEXT;
ALTER TABLE source ADD COLUMN listing_opened_at TEXT;
ALTER TABLE package ADD COLUMN listing_opened_at TEXT;
