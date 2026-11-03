import { sql } from 'kysely';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createNotificationCredentials } from '@package-broker/core/runtime/notification-jobs';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { createCredentialRepository } from '../repositories/credential.js';
import { notificationCaptureStatements } from '../repositories/notification-capture.js';
import {
  NOW,
  PROJECT_A,
  capturePlan,
  publishedEvent,
  rows,
  run,
  seedNotificationWorld,
} from '../contract/notification-fixture.js';

export const SIGNING_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export { seedNotificationWorld };

/** An enabled endpoint whose configuration is sealed with the broker's own keyring. */
export async function seedDeliverableEndpoint(
  executor: SqlExecutor,
  ctx: OrgContext,
  keyring: Keyring,
  input: { readonly id: string; readonly url: string },
): Promise<void> {
  const repository = createCredentialRepository(executor);
  const store = createCredentialStore({
    repository,
    cipher: createSecretCipher(keyring, 'credential-encryption'),
    ids: { ulid },
    clock: systemClock,
  });
  const sealed = await createNotificationCredentials({ store, repository }).prepare(
    ctx,
    { projectId: PROJECT_A, endpointId: input.id },
    {
      url: input.url,
      headers: [['Authorization', 'Bearer runtime-test']],
      signingKey: SIGNING_KEY,
      template: null,
    },
  );
  await executor.batch([sealed.statement]);
  await run(
    executor,
    `INSERT INTO notification_endpoint (org_id, project_id, id, name, method, events_json, package_pattern,
       credential_id, state, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'POST', '["npm.package.published"]', '*', ?, 'enabled', 1, ?, ?)`,
    ctx.orgId,
    PROJECT_A,
    input.id,
    input.id,
    sealed.credentialId,
    NOW,
    NOW,
  );
}

/** Commits one published event with its recipients and dispatch job, as a package write would. */
export async function capturePublished(
  executor: SqlExecutor,
  ctx: OrgContext,
  version = '1.0.0',
  occurredAt = new Date().toISOString(),
): Promise<string> {
  const plan = capturePlan(ctx, [publishedEvent({ version })]);
  await executor.batch(
    notificationCaptureStatements(ctx, { ...plan, occurredAt }, sql<boolean>`1`),
  );
  return plan.operationId;
}

export async function deliveries(executor: SqlExecutor, ctx: OrgContext) {
  return rows<{
    endpoint_id: string;
    state: string;
    attempts: number;
    outcome_code: string | null;
  }>(
    executor,
    'SELECT endpoint_id, state, attempts, outcome_code FROM notification_delivery WHERE org_id = ? ORDER BY endpoint_id',
    ctx.orgId,
  );
}
