-- Package Broker 2.0, migration 0016. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Expand only: index installation startup checks and credential re-seed sampling.
CREATE INDEX token_pepper_version ON token (pepper_version);
CREATE INDEX credential_version_in_use ON credential (key_version);
