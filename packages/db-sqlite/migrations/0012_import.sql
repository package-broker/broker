-- pb:phase expand

ALTER TABLE import_run ADD COLUMN approved_by_user_id TEXT REFERENCES user_account (id);
ALTER TABLE import_run ADD COLUMN approved_at TEXT;
ALTER TABLE import_run ADD COLUMN credential_window_until TEXT;
ALTER TABLE import_run ADD COLUMN started_by_service_principal_id TEXT REFERENCES service_principal (id);
ALTER TABLE import_run ADD COLUMN manifest_blob_sha256 TEXT CHECK (manifest_blob_sha256 IS NULL OR length(manifest_blob_sha256) = 64);

CREATE INDEX import_run_approver ON import_run (approved_by_user_id);
CREATE INDEX import_run_sp_starter ON import_run (started_by_service_principal_id);

ALTER TABLE import_ref ADD COLUMN published_at_basis TEXT CHECK (published_at_basis IS NULL OR published_at_basis IN ('source_release', 'packagist_added', 'import_time'));
