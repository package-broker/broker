-- pb:phase contract
-- Package Broker 2.0, migration 0006 (ports: jobs and blob). SQLite dialect (Cloudflare D1, better-sqlite3, node:sqlite).
-- Job provenance (project_id, initiator_token_id) and the blob purge columns are plain ADD COLUMNs.
-- job_attempt is rebuilt because SQLite cannot alter a CHECK: outcome gains released and loses dead (stored dead maps to failed).
-- Contract phase because the rebuild drops and renames a table.

ALTER TABLE job ADD COLUMN project_id TEXT REFERENCES project (id);
ALTER TABLE job ADD COLUMN initiator_token_id TEXT;

CREATE TABLE job_attempt_0006 (
  id          TEXT NOT NULL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organization (id),
  job_id      TEXT NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL CHECK (attempt >= 1),
  fence       INTEGER NOT NULL CHECK (fence >= 1),
  worker      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'succeeded', 'failed', 'lease_expired', 'released')),
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  next_run_at TEXT
) STRICT;
INSERT INTO job_attempt_0006 (id, org_id, job_id, attempt, fence, worker, outcome, error, started_at, finished_at, next_run_at)
  SELECT id, org_id, job_id, attempt, fence, worker,
         CASE outcome WHEN 'dead' THEN 'failed' ELSE outcome END,
         error, started_at, finished_at, next_run_at
  FROM job_attempt;
DROP TABLE job_attempt;
ALTER TABLE job_attempt_0006 RENAME TO job_attempt;
CREATE UNIQUE INDEX job_attempt_fence ON job_attempt (job_id, fence);
ALTER TABLE blob ADD COLUMN purge_generation TEXT;
ALTER TABLE blob ADD COLUMN purge_lease_until TEXT;
