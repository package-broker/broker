-- pb:phase expand

CREATE UNIQUE INDEX credential_notification_scope ON credential (org_id, project_id, id);

CREATE TABLE notification_endpoint (
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CONSTRAINT notification_endpoint_name CHECK (length(name) BETWEEN 1 AND 80),
  method TEXT NOT NULL CONSTRAINT notification_endpoint_method CHECK (method IN ('POST', 'PUT')),
  events_json TEXT NOT NULL CONSTRAINT notification_endpoint_events CHECK (json_valid(events_json) AND json_type(events_json) = 'array' AND json_array_length(events_json) >= 1 AND length(events_json) <= 256),
  package_pattern TEXT NOT NULL CONSTRAINT notification_endpoint_pattern CHECK (length(package_pattern) BETWEEN 1 AND 50),
  credential_id TEXT NOT NULL,
  headers_configured INTEGER NOT NULL DEFAULT 0 CONSTRAINT notification_endpoint_headers CHECK (headers_configured IN (0, 1)),
  template_configured INTEGER NOT NULL DEFAULT 0 CONSTRAINT notification_endpoint_template CHECK (template_configured IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT notification_endpoint_revision CHECK (revision >= 1),
  state TEXT NOT NULL DEFAULT 'disabled' CONSTRAINT notification_endpoint_state CHECK (state IN ('enabled', 'disabled', 'deleted')),
  disabled_reason TEXT CONSTRAINT notification_endpoint_reason CHECK (disabled_reason IN ('manual', 'configuration_changed', 'failures', 'credentials', 'policy', 'gone')),
  failure_streak INTEGER NOT NULL DEFAULT 0 CONSTRAINT notification_endpoint_streak CHECK (failure_streak >= 0),
  last_op_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, project_id, id),
  CONSTRAINT notification_endpoint_enabled CHECK (state <> 'enabled' OR disabled_reason IS NULL),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, project_id, credential_id) REFERENCES credential (org_id, project_id, id)
) STRICT;

CREATE INDEX notification_endpoint_project ON notification_endpoint (org_id, project_id, state, id);

CREATE TABLE notification_event (
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0 CONSTRAINT notification_event_ordinal CHECK (ordinal >= 0),
  event_type TEXT NOT NULL CONSTRAINT notification_event_type CHECK (event_type IN ('npm.package.published', 'npm.package.released', 'npm.package.unpublished', 'npm.package.deprecation_changed', 'npm.package.dist_tag_changed')),
  source_id TEXT NOT NULL,
  package_key TEXT NOT NULL CONSTRAINT notification_event_key CHECK (length(CAST(package_key AS BLOB)) BETWEEN 1 AND 512),
  payload_json TEXT NOT NULL CONSTRAINT notification_event_payload CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 16384),
  occurred_at TEXT NOT NULL,
  dispatched_at TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 1 CONSTRAINT notification_event_generation CHECK (dispatch_generation >= 1),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, project_id, id),
  UNIQUE (org_id, operation_id, event_type, ordinal),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id)
) STRICT;

CREATE INDEX notification_event_dispatch ON notification_event (org_id, dispatched_at, id);
CREATE INDEX notification_event_retention ON notification_event (org_id, occurred_at, id);

CREATE TABLE notification_delivery (
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  endpoint_revision INTEGER NOT NULL CONSTRAINT notification_delivery_endpoint_revision CHECK (endpoint_revision >= 1),
  configuration_credential_id TEXT NOT NULL,
  body_credential_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT notification_delivery_state CHECK (state IN ('pending', 'sending', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT notification_delivery_attempts CHECK (attempts BETWEEN 0 AND 8),
  job_generation INTEGER NOT NULL DEFAULT 1 CONSTRAINT notification_delivery_generation CHECK (job_generation >= 1),
  active_job_id TEXT,
  active_fence INTEGER CONSTRAINT notification_delivery_fence CHECK (active_fence >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT notification_delivery_revision CHECK (revision >= 1),
  next_attempt_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_status INTEGER CONSTRAINT notification_delivery_status CHECK (last_status BETWEEN 100 AND 599),
  outcome_code TEXT CONSTRAINT notification_delivery_outcome CHECK (outcome_code IN ('ok', 'network', 'timeout', 'http_retry', 'http_permanent', 'redirect', 'policy', 'credentials', 'template', 'unknown', 'expired', 'attempt_limit', 'disabled', 'superseded', 'project_inactive', 'admission_lost', 'deleted')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, event_id, endpoint_id),
  UNIQUE (org_id, project_id, id),
  FOREIGN KEY (org_id, project_id, event_id) REFERENCES notification_event (org_id, project_id, id),
  FOREIGN KEY (org_id, project_id, endpoint_id) REFERENCES notification_endpoint (org_id, project_id, id),
  FOREIGN KEY (org_id, project_id, configuration_credential_id) REFERENCES credential (org_id, project_id, id),
  FOREIGN KEY (org_id, project_id, body_credential_id) REFERENCES credential (org_id, project_id, id),
  CONSTRAINT notification_delivery_finished CHECK ((state IN ('delivered', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT notification_delivery_sending CHECK (state <> 'sending' OR (active_job_id IS NOT NULL AND active_fence IS NOT NULL))
) STRICT;

CREATE INDEX notification_delivery_due ON notification_delivery (org_id, state, next_attempt_at, id);
CREATE INDEX notification_delivery_history ON notification_delivery (org_id, project_id, endpoint_id, created_at, id);
CREATE INDEX notification_delivery_retention ON notification_delivery (org_id, finished_at, id);

CREATE TABLE notification_attempt (
  org_id TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CONSTRAINT notification_attempt_number CHECK (attempt BETWEEN 1 AND 8),
  job_id TEXT NOT NULL,
  fence INTEGER NOT NULL CONSTRAINT notification_attempt_fence CHECK (fence >= 1),
  outcome TEXT NOT NULL CONSTRAINT notification_attempt_outcome CHECK (outcome IN ('started', 'delivered', 'retry', 'failed', 'unknown')),
  outcome_code TEXT CONSTRAINT notification_attempt_code CHECK (outcome_code IN ('ok', 'network', 'timeout', 'http_retry', 'http_permanent', 'redirect', 'policy', 'credentials', 'template', 'unknown')),
  status INTEGER CONSTRAINT notification_attempt_status CHECK (status BETWEEN 100 AND 599),
  duration_ms INTEGER CONSTRAINT notification_attempt_duration CHECK (duration_ms >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (org_id, delivery_id, attempt),
  FOREIGN KEY (org_id, project_id, delivery_id) REFERENCES notification_delivery (org_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_attempt_finished CHECK ((outcome = 'started') = (finished_at IS NULL))
) STRICT;

CREATE INDEX notification_attempt_started ON notification_attempt (org_id, outcome, started_at, delivery_id);
