-- Package Broker 2.0, migration 0004. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Metadata cache epoch: one random token per organization. A missing row means no cache read and no fill.
-- Expand only: adds one table and seeds it for the organizations that exist. No triggers.

CREATE TABLE cache_epoch (
  org_id  TEXT NOT NULL PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  version TEXT NOT NULL
) STRICT;

INSERT INTO cache_epoch (org_id, version) SELECT id, hex(randomblob(16)) FROM organization;
