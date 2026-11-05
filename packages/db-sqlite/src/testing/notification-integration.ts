import { hashPassword } from '@package-broker/core/auth/password';
import { encodeTotpEnvelope, generateTotpSecret } from '@package-broker/core/auth/totp';
import { createSecretCipher, credentialAad } from '@package-broker/core/secrets/cipher';
import { verifyKeyring } from '@package-broker/core/secrets/keyring-verifier';
import { createKeyringVerifierStore } from '../repositories/keyring-verifier.js';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import type { SqlExecutor, SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { createOrganizationBootstrap } from '../repositories/organization.js';

const SESSION = 's'.repeat(43);
const CSRF = 'c'.repeat(43);

/** What the acceptance scenario needs to act as a human administrator and as a publisher. */
export interface IntegrationWorld {
  readonly orgId: string;
  readonly projects: { readonly alpha: string; readonly beta: string };
  readonly sessionHeaders: Readonly<Record<string, string>>;
  readonly publishToken: string;
}

async function run(executor: SqlExecutor, sql: string, ...params: SqlValue[]) {
  await executor.batch([{ sql, params }]);
}

/**
 * One organization with projects alpha and beta, both attached to a hosted npm source claiming
 * `@acme/*`; alpha also has a hosted source claiming `@held/*` that requires approval. A human
 * session with a fresh reauthentication holds settings, approval and package authority; a service
 * token publishes and manages packages.
 */
export async function seedIntegrationWorld(
  executor: SqlExecutor,
  keyring: Keyring,
): Promise<IntegrationWorld> {
  const orgId = ulid();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  const alpha = ulid();
  const beta = ulid();
  for (const [id, slug] of [
    [alpha, 'alpha'],
    [beta, 'beta'],
  ] as const)
    await run(
      executor,
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      id,
      orgId,
      slug,
      slug,
    );
  const active = ulid();
  const held = ulid();
  for (const [id, name, pattern, approval] of [
    [active, 'Active', '@acme/*', 0],
    [held, 'Held', '@held/*', 1],
  ] as const) {
    await run(
      executor,
      "INSERT INTO source (id, org_id, name, ecosystem, type, require_publish_approval) VALUES (?, ?, ?, 'npm', 'hosted', ?)",
      id,
      orgId,
      name,
      approval,
    );
    await run(
      executor,
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', ?)",
      ulid(),
      orgId,
      id,
      pattern,
    );
  }
  for (const [project, source] of [
    [alpha, active],
    [alpha, held],
    [beta, active],
  ] as const)
    await run(
      executor,
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      orgId,
      project,
      source,
    );

  const userId = ulid();
  const roleId = ulid();
  const credentialId = ulid();
  await run(
    executor,
    'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    userId,
    orgId,
    'admin@acme.test',
  );
  await run(
    executor,
    "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'notify-admin', 'Notify admin', 'organization', 1)",
    roleId,
    orgId,
  );
  for (const permission of [
    'org:read',
    'org:packages:read',
    'org:packages:approve',
    'project:read',
    'project:settings:write',
    'project:packages:read',
  ])
    await run(
      executor,
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      orgId,
      roleId,
      permission,
    );
  await run(
    executor,
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'admin@acme.test', 'organization', ?)",
    ulid(),
    orgId,
    roleId,
  );
  await verifyKeyring(keyring, createKeyringVerifierStore(executor));
  const aad = credentialAad({ id: credentialId, orgId, kind: 'totp' });
  const sealed = await createSecretCipher(keyring, 'credential-encryption').seal(
    encodeTotpEnvelope(userId, generateTotpSecret()),
    aad,
  );
  await run(
    executor,
    "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
    credentialId,
    orgId,
    sealed.ciphertext,
    sealed.nonce,
    sealed.keyVersion,
    aad,
  );
  await run(
    executor,
    "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    userId,
    orgId,
    await hashPassword('notification acceptance password', keyring),
    credentialId,
  );
  await run(
    executor,
    "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, last_seen_at, reauth_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ulid(),
    orgId,
    userId,
    await sha256Hex(SESSION),
    await sha256Hex(CSRF),
  );

  const principal = ulid();
  await run(
    executor,
    'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
    principal,
    orgId,
    'publisher',
    userId,
  );
  for (const permission of [
    'org:packages:publish',
    'project:packages:read',
    'project:packages:write',
    'project:packages:manage',
  ])
    await run(
      executor,
      'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
      orgId,
      principal,
      permission,
    );
  const publishToken = formatToken(
    'svc',
    'notifypublsh',
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await run(
    executor,
    "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, service_principal_id, expires_at, project_mode) VALUES (?, ?, 'svc', 'notifypublsh', ?, 1, 'publish', '[\"full\"]', 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'), 'all')",
    ulid(),
    orgId,
    await hashToken(keyring, 1, publishToken),
    principal,
  );
  return {
    orgId,
    projects: { alpha, beta },
    sessionHeaders: {
      cookie: `__Host-pb_session=${SESSION}; __Host-pb_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
    },
    publishToken,
  };
}

/**
 * Moves one waiting delivery's clock back so its next nominal slot and the minimum retry spacing
 * have passed, then makes its job runnable; the stand-in for waiting five minutes.
 */
export async function advanceRetry(executor: SqlExecutor, orgId: string): Promise<void> {
  const shift = '-10 minutes';
  await executor.batch([
    {
      sql: "UPDATE notification_attempt SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, ?), finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', finished_at, ?) WHERE org_id = ? AND delivery_id IN (SELECT id FROM notification_delivery WHERE org_id = ? AND state = 'pending' AND attempts > 0)",
      params: [shift, shift, orgId, orgId],
    },
    {
      sql: "UPDATE notification_delivery SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?), next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at, ?) WHERE org_id = ? AND state = 'pending' AND attempts > 0",
      params: [shift, shift, orgId],
    },
    {
      sql: "UPDATE job SET run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE org_id = ? AND state = 'queued' AND type = 'core:notification-deliver:v1'",
      params: [orgId],
    },
  ]);
}

/** Whether notification work is still runnable now: queued and due, or running, or undispatched. */
export async function notificationBusy(executor: SqlExecutor, orgId: string): Promise<boolean> {
  const [row] = await executor.all<{ busy: number }>({
    sql: `SELECT
      (SELECT count(*) FROM job WHERE org_id = ? AND type IN ('core:notification-dispatch:v1', 'core:notification-deliver:v1')
        AND (state = 'running' OR (state = 'queued' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
      + (SELECT count(*) FROM notification_delivery WHERE org_id = ? AND state = 'sending') AS busy`,
    params: [orgId, orgId],
  });
  return (row?.busy ?? 0) > 0;
}

export interface DeliveryRow {
  readonly id: string;
  readonly project_id: string;
  readonly endpoint_id: string;
  readonly event_type: string;
  readonly state: string;
  readonly attempts: number;
  readonly outcome_code: string | null;
}

export async function integrationDeliveries(
  executor: SqlExecutor,
  orgId: string,
): Promise<DeliveryRow[]> {
  return executor.all<DeliveryRow>({
    sql: `SELECT d.id, d.project_id, d.endpoint_id, e.event_type, d.state, d.attempts, d.outcome_code
      FROM notification_delivery AS d JOIN notification_event AS e ON e.org_id = d.org_id AND e.id = d.event_id
      WHERE d.org_id = ? ORDER BY d.created_at, d.id`,
    params: [orgId],
  });
}

export async function integrationEvents(executor: SqlExecutor, orgId: string) {
  return executor.all<{ project_id: string; event_type: string; payload_json: string }>({
    sql: 'SELECT project_id, event_type, payload_json FROM notification_event WHERE org_id = ? ORDER BY occurred_at, ordinal, id',
    params: [orgId],
  });
}

/** Every stored row a secret must never reach: jobs, attempts, audit and notification state. */
export async function storedTexts(executor: SqlExecutor, orgId: string): Promise<string> {
  const tables = [
    'SELECT type, payload_json, last_error, sync_error FROM job WHERE org_id = ?',
    'SELECT * FROM job_attempt WHERE org_id = ?',
    'SELECT * FROM audit_pending WHERE org_id = ?',
    'SELECT * FROM audit_event WHERE org_id = ?',
    'SELECT * FROM notification_endpoint WHERE org_id = ?',
    'SELECT * FROM notification_event WHERE org_id = ?',
    'SELECT * FROM notification_delivery WHERE org_id = ?',
    'SELECT * FROM notification_attempt WHERE org_id = ?',
  ];
  const parts: string[] = [];
  for (const sql of tables)
    parts.push(JSON.stringify(await executor.all({ sql, params: [orgId] })));
  return parts.join('\n');
}
