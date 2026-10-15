-- Package Broker 2.0, migration 0003. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Access model: optimistic revisions, token validation origin, durable service authority,
-- identity blocks and the mutation guard.
-- Expand only: adds columns, three tables and two indexes (token_validation_identity,
-- identity_block_user) plus the service_principal (org_id, id) unique index. Existing rows gain no authority.

ALTER TABLE role ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE role ADD COLUMN last_op_id TEXT;
ALTER TABLE access_grant ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE access_grant ADD COLUMN last_op_id TEXT;
ALTER TABLE project ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE project ADD COLUMN last_op_id TEXT;
ALTER TABLE service_principal ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE service_principal ADD COLUMN last_op_id TEXT;

ALTER TABLE token ADD COLUMN project_mode TEXT NOT NULL DEFAULT 'selected' CHECK (project_mode IN ('all', 'selected'));
ALTER TABLE token ADD COLUMN validation_kind TEXT CHECK (validation_kind IS NULL OR (validation_kind IN ('sso', 'local') AND kind = 'pat'));
ALTER TABLE token ADD COLUMN validation_identity_id TEXT REFERENCES identity (id) ON DELETE SET NULL
  CHECK (validation_identity_id IS NULL OR (validation_kind IS NOT 'local' AND kind = 'pat'));
ALTER TABLE token ADD COLUMN last_op_id TEXT;
CREATE INDEX token_validation_identity ON token (validation_identity_id) WHERE validation_identity_id IS NOT NULL;

CREATE UNIQUE INDEX service_principal_org_id ON service_principal (org_id, id);

CREATE TABLE service_principal_permission (
  org_id               TEXT NOT NULL REFERENCES organization (id),
  service_principal_id TEXT NOT NULL,
  permission           TEXT NOT NULL,
  PRIMARY KEY (org_id, service_principal_id, permission),
  FOREIGN KEY (org_id, service_principal_id) REFERENCES service_principal (org_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE identity_block (
  org_id             TEXT NOT NULL REFERENCES organization (id),
  provider           TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  issuer             TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  subject            TEXT NOT NULL CHECK (length(subject) >= 1),
  blocked_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  blocked_by_user_id TEXT REFERENCES user_account (id),
  PRIMARY KEY (org_id, provider, issuer, subject)
) STRICT, WITHOUT ROWID;
CREATE INDEX identity_block_user ON identity_block (blocked_by_user_id) WHERE blocked_by_user_id IS NOT NULL;

CREATE TABLE access_mutation_guard (
  key TEXT NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64)
) STRICT;
