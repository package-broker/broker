-- pb:phase contract

CREATE TABLE npm_login_session_handoff (
  id TEXT NOT NULL PRIMARY KEY,
  selector_hash TEXT NOT NULL UNIQUE CONSTRAINT selector_hash_hex CHECK (length(CAST(selector_hash AS BLOB)) = 64 AND instr(selector_hash, char(0)) = 0 AND selector_hash NOT GLOB '*[^0-9a-f]*'),
  done_hash TEXT NOT NULL UNIQUE CONSTRAINT done_hash_hex CHECK (length(CAST(done_hash AS BLOB)) = 64 AND instr(done_hash, char(0)) = 0 AND done_hash NOT GLOB '*[^0-9a-f]*'),
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT login_state CHECK (state IN ('pending', 'approved', 'delivering', 'consumed')),
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
  delivering_at TEXT,
  CONSTRAINT login_delivering CHECK ((state = 'delivering') = (delivering_at IS NOT NULL)),
  CONSTRAINT login_delivery_token CHECK (state <> 'delivering' OR (user_id IS NOT NULL AND token_id IS NOT NULL AND token_ciphertext IS NULL)),
  CONSTRAINT login_sealed_token CHECK ((token_ciphertext IS NULL AND token_nonce IS NULL AND token_key_version IS NULL) OR (token_ciphertext IS NOT NULL AND token_nonce IS NOT NULL AND token_key_version IS NOT NULL)),
  CONSTRAINT login_consumed_time CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT login_consumed_token CHECK (state <> 'consumed' OR token_ciphertext IS NULL),
  CONSTRAINT login_approved CHECK (state <> 'approved' OR (user_id IS NOT NULL AND token_id IS NOT NULL AND token_ciphertext IS NOT NULL)),
  CONSTRAINT login_pending CHECK (state <> 'pending' OR (user_id IS NULL AND token_id IS NULL AND token_ciphertext IS NULL)),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, user_id) REFERENCES user_account (org_id, id),
  FOREIGN KEY (org_id, token_id) REFERENCES token (org_id, id)
) STRICT;

INSERT INTO npm_login_session_handoff (id, selector_hash, done_hash, org_id, project_id, state, cli_hostname, source_ip, created_at, expires_at, user_id, token_id, token_ciphertext, token_nonce, token_key_version, consumed_at)
SELECT id, selector_hash, done_hash, org_id, project_id, state, cli_hostname, source_ip, created_at, expires_at, user_id, token_id, token_ciphertext, token_nonce, token_key_version, consumed_at FROM npm_login_session;
DROP TABLE npm_login_session;
ALTER TABLE npm_login_session_handoff RENAME TO npm_login_session;
CREATE INDEX npm_login_session_pending ON npm_login_session (org_id, project_id, expires_at) WHERE state = 'pending';
CREATE INDEX npm_login_session_expiry ON npm_login_session (org_id, expires_at);
CREATE INDEX npm_login_session_delivery ON npm_login_session (org_id, delivering_at) WHERE state = 'delivering';
