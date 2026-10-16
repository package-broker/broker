-- pb:phase expand
-- Package Broker 2.0, migration 0008. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Representation clocks: track the winning package and its revision.
-- Expand only: adds two columns. No triggers, no change to an earlier migration.

ALTER TABLE representation_clock ADD COLUMN rev INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0);
ALTER TABLE representation_clock ADD COLUMN package_id TEXT NOT NULL DEFAULT '';
