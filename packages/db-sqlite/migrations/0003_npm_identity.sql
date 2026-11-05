-- pb:phase expand

CREATE TABLE trusted_publisher (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  package_name TEXT NOT NULL CONSTRAINT package_name_bytes CHECK (package_name IS NULL OR length(CAST(package_name AS BLOB)) <= 214) CONSTRAINT package_name_controls CHECK (package_name IS NULL OR (instr(package_name, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), package_name) = 0)),
  repository_id TEXT NOT NULL CONSTRAINT repository_id_digits CHECK (length(repository_id) > 0 AND instr(repository_id, char(0)) = 0 AND repository_id NOT GLOB '*[^0-9]*'),
  repository_owner_id TEXT NOT NULL CONSTRAINT repository_owner_id_digits CHECK (length(repository_owner_id) > 0 AND instr(repository_owner_id, char(0)) = 0 AND repository_owner_id NOT GLOB '*[^0-9]*'),
  repository TEXT NOT NULL CONSTRAINT repository_bytes CHECK (repository IS NULL OR length(CAST(repository AS BLOB)) <= 140) CONSTRAINT repository_controls CHECK (repository IS NULL OR (instr(repository, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), repository) = 0)),
  workflow TEXT NOT NULL CONSTRAINT workflow_bytes CHECK (workflow IS NULL OR length(CAST(workflow AS BLOB)) <= 255) CONSTRAINT workflow_controls CHECK (workflow IS NULL OR (instr(workflow, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), workflow) = 0)),
  environment TEXT NOT NULL DEFAULT '' CONSTRAINT environment_bytes CHECK (environment IS NULL OR length(CAST(environment AS BLOB)) <= 255) CONSTRAINT environment_controls CHECK (environment IS NULL OR (instr(environment, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), environment) = 0)),
  ref_pattern TEXT CONSTRAINT ref_pattern_bytes CHECK (ref_pattern IS NULL OR length(CAST(ref_pattern AS BLOB)) <= 255) CONSTRAINT ref_pattern_controls CHECK (ref_pattern IS NULL OR (instr(ref_pattern, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), ref_pattern) = 0)),
  service_principal_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  disabled_at TEXT,
  last_used_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT publisher_revision CHECK (revision >= 1),
  FOREIGN KEY (org_id, service_principal_id) REFERENCES service_principal (org_id, id),
  FOREIGN KEY (org_id, created_by_user_id) REFERENCES user_account (org_id, id)
) STRICT;

CREATE UNIQUE INDEX trusted_publisher_org_id ON trusted_publisher (org_id, id);
CREATE UNIQUE INDEX trusted_publisher_binding ON trusted_publisher (org_id, package_name, repository_id, workflow, environment);

ALTER TABLE token ADD COLUMN trusted_publisher_id TEXT REFERENCES trusted_publisher (id) ON DELETE SET NULL;
ALTER TABLE token ADD COLUMN package_name TEXT CONSTRAINT package_name_bytes CHECK (package_name IS NULL OR length(CAST(package_name AS BLOB)) <= 214) CONSTRAINT package_name_controls CHECK (package_name IS NULL OR (instr(package_name, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), package_name) = 0));
CREATE UNIQUE INDEX token_org_id ON token (id, org_id);
CREATE INDEX token_trusted_publisher ON token (org_id, trusted_publisher_id) WHERE trusted_publisher_id IS NOT NULL;

-- ADD COLUMN cannot add a composite foreign key to the existing token table.
CREATE TRIGGER token_trusted_publisher_insert BEFORE INSERT ON token
WHEN NEW.trusted_publisher_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM trusted_publisher WHERE org_id = NEW.org_id AND id = NEW.trusted_publisher_id
)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER token_trusted_publisher_update BEFORE UPDATE OF org_id, trusted_publisher_id ON token
WHEN NEW.trusted_publisher_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM trusted_publisher WHERE org_id = NEW.org_id AND id = NEW.trusted_publisher_id
)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER trusted_publisher_token_org_update BEFORE UPDATE OF org_id ON trusted_publisher
WHEN EXISTS (
  SELECT 1 FROM token WHERE trusted_publisher_id = OLD.id AND org_id <> NEW.org_id
)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TABLE npm_login_session (
  id TEXT NOT NULL PRIMARY KEY,
  selector_hash TEXT NOT NULL UNIQUE CONSTRAINT selector_hash_hex CHECK (length(CAST(selector_hash AS BLOB)) = 64 AND instr(selector_hash, char(0)) = 0 AND selector_hash NOT GLOB '*[^0-9a-f]*'),
  done_hash TEXT NOT NULL UNIQUE CONSTRAINT done_hash_hex CHECK (length(CAST(done_hash AS BLOB)) = 64 AND instr(done_hash, char(0)) = 0 AND done_hash NOT GLOB '*[^0-9a-f]*'),
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT login_state CHECK (state IN ('pending', 'approved', 'consumed')),
  cli_hostname TEXT CONSTRAINT cli_hostname_bytes CHECK (cli_hostname IS NULL OR length(CAST(cli_hostname AS BLOB)) <= 253) CONSTRAINT cli_hostname_controls CHECK (cli_hostname IS NULL OR (instr(cli_hostname, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), cli_hostname) = 0)),
  source_ip TEXT CONSTRAINT source_ip_bytes CHECK (source_ip IS NULL OR length(CAST(source_ip AS BLOB)) <= 45) CONSTRAINT source_ip_controls CHECK (source_ip IS NULL OR (instr(source_ip, char(0)) = 0 AND glob(char(42,91,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,93,42), source_ip) = 0)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  user_id TEXT,
  token_id TEXT,
  token_ciphertext TEXT,
  token_nonce TEXT,
  token_key_version INTEGER,
  consumed_at TEXT,
  CONSTRAINT login_sealed_token CHECK ((token_ciphertext IS NULL AND token_nonce IS NULL AND token_key_version IS NULL) OR (token_ciphertext IS NOT NULL AND token_nonce IS NOT NULL AND token_key_version IS NOT NULL)),
  CONSTRAINT login_consumed_time CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT login_consumed_token CHECK (state <> 'consumed' OR token_ciphertext IS NULL),
  CONSTRAINT login_approved CHECK (state <> 'approved' OR (user_id IS NOT NULL AND token_id IS NOT NULL AND token_ciphertext IS NOT NULL)),
  CONSTRAINT login_pending CHECK (state <> 'pending' OR (user_id IS NULL AND token_id IS NULL AND token_ciphertext IS NULL)),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, user_id) REFERENCES user_account (org_id, id),
  FOREIGN KEY (org_id, token_id) REFERENCES token (org_id, id)
) STRICT;

CREATE INDEX npm_login_session_pending ON npm_login_session (org_id, project_id, expires_at) WHERE state = 'pending';
CREATE INDEX npm_login_session_expiry ON npm_login_session (org_id, expires_at);

CREATE TABLE oidc_replay (
  issuer TEXT NOT NULL,
  jti TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organization (id),
  trusted_publisher_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (issuer, jti),
  FOREIGN KEY (org_id, trusted_publisher_id) REFERENCES trusted_publisher (org_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX oidc_replay_expiry ON oidc_replay (org_id, expires_at);
