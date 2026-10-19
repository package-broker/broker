-- Package Broker 2.0, migration 0015. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Keyring verifier: one MAC per master key version that has been the current key. Global, not per organization.
-- Expand only: adds one table. No triggers.

CREATE TABLE keyring_verifier (
  key_version INTEGER NOT NULL PRIMARY KEY CHECK (key_version >= 1),
  mac         BLOB NOT NULL CHECK (length(mac) = 32),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;
