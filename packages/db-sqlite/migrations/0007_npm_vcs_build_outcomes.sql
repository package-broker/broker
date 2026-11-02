CREATE TABLE npm_vcs_build_outcome (
  org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  source_ref TEXT NOT NULL CHECK(length(source_ref) = 40),
  packing_policy TEXT NOT NULL,
  retry_generation INTEGER NOT NULL DEFAULT 0 CHECK(retry_generation >= 0),
  outcome TEXT CHECK(outcome IN ('too_large', 'unsupported_files_pattern', 'invalid_packlist', 'invalid_tarball', 'archive_changed', 'internal')),
  PRIMARY KEY (org_id, version_id, source_ref, packing_policy),
  FOREIGN KEY (version_id, org_id) REFERENCES version(id, org_id) ON DELETE CASCADE
) STRICT;
