-- Package Broker 2.0, migration 0002. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Local admin login, identity provider trust binding and per-identity freshness.
-- Expand only: adds two tables and one nullable column.

CREATE TABLE local_login (
  user_id            TEXT NOT NULL PRIMARY KEY REFERENCES user_account (id),
  org_id             TEXT NOT NULL REFERENCES organization (id),
  password_hash      TEXT CHECK (password_hash IS NULL OR password_hash GLOB 'pbkdf2-sha256$*'),
  totp_credential_id TEXT REFERENCES credential (id) ON DELETE SET NULL,
  totp_enabled_at    TEXT,
  totp_last_step     INTEGER CHECK (totp_last_step IS NULL OR totp_last_step >= 0),
  credential_rev     INTEGER NOT NULL DEFAULT 0 CHECK (credential_rev >= 0),
  setup_hash         TEXT CHECK (setup_hash IS NULL OR (length(setup_hash) = 64 AND setup_hash NOT GLOB '*[^0-9a-f]*')),
  setup_expires_at   TEXT,
  failed_count       INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until       TEXT,
  last_op_id         TEXT,
  last_login_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((setup_hash IS NULL) = (setup_expires_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX local_login_setup ON local_login (setup_hash) WHERE setup_hash IS NOT NULL;
CREATE INDEX local_login_org ON local_login (org_id);
CREATE UNIQUE INDEX local_login_totp ON local_login (totp_credential_id) WHERE totp_credential_id IS NOT NULL;

CREATE TABLE identity_provider_binding (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  provider   TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND provider = trim(provider)),
  anchor     TEXT NOT NULL CHECK (length(anchor) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, provider)
) STRICT, WITHOUT ROWID;

ALTER TABLE identity ADD COLUMN validated_at TEXT;
