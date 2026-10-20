-- pb:phase expand
ALTER TABLE import_run ADD COLUMN rollback_restored_count INTEGER NOT NULL DEFAULT 0 CHECK (rollback_restored_count >= 0);
ALTER TABLE import_run ADD COLUMN rollback_conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (rollback_conflict_count >= 0);
ALTER TABLE import_run ADD COLUMN rollback_expired_count INTEGER NOT NULL DEFAULT 0 CHECK (rollback_expired_count >= 0);

ALTER TABLE import_ref ADD COLUMN expired_at TEXT;
