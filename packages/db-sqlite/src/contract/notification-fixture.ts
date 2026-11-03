import type { NotificationEventType } from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor, SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { CaptureEventInput } from '@package-broker/core/db/notifications';
import type { CaptureInput } from '../repositories/notification-capture.js';

/** Envelope project ids are ULIDs, so notification fixtures cannot reuse the short ids of older contracts. */
export const PROJECT_A = '01J0PR0JECT0000000000000PA';
export const PROJECT_B = '01J0PR0JECT0000000000000PB';
export const SOURCE = 'S-hosted';
export const NOW = '2026-11-01T12:00:00.000Z';

export async function run(executor: SqlExecutor, sql: string, ...params: SqlValue[]) {
  await executor.batch([{ sql, params }]);
}

export async function rows<T = Record<string, unknown>>(
  executor: SqlExecutor,
  sql: string,
  ...params: SqlValue[]
): Promise<T[]> {
  return executor.all<T>({ sql, params });
}

/** Two projects of one organization, both attached to one hosted npm source. */
export async function seedNotificationWorld(executor: SqlExecutor, ctx: OrgContext): Promise<void> {
  for (const [id, slug] of [
    [PROJECT_A, 'project-a'],
    [PROJECT_B, 'project-b'],
  ] as const) {
    await run(
      executor,
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      id,
      ctx.orgId,
      slug,
      slug,
    );
  }
  await run(
    executor,
    "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'Hosted', 'npm', 'hosted')",
    SOURCE,
    ctx.orgId,
  );
  for (const project of [PROJECT_A, PROJECT_B])
    await run(
      executor,
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      ctx.orgId,
      project,
      SOURCE,
    );
}

export interface EndpointSeed {
  readonly id: string;
  readonly projectId?: string;
  readonly events?: readonly NotificationEventType[];
  readonly pattern?: string;
  readonly state?: 'enabled' | 'disabled' | 'deleted';
  readonly revision?: number;
}

export async function seedEndpoint(
  executor: SqlExecutor,
  ctx: OrgContext,
  seed: EndpointSeed,
): Promise<void> {
  const projectId = seed.projectId ?? PROJECT_A;
  const credential = `C-${seed.id}`;
  await run(
    executor,
    "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, 'npm-notification', x'00', zeroblob(12), 1, 'aad')",
    credential,
    ctx.orgId,
    projectId,
  );
  const state = seed.state ?? 'enabled';
  await run(
    executor,
    `INSERT INTO notification_endpoint (org_id, project_id, id, name, method, events_json, package_pattern,
       credential_id, state, disabled_reason, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'POST', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId,
    projectId,
    seed.id,
    seed.id,
    JSON.stringify(seed.events ?? ['npm.package.published']),
    seed.pattern ?? '*',
    credential,
    state,
    state === 'disabled' ? 'manual' : null,
    seed.revision ?? 1,
    NOW,
    NOW,
  );
}

export function publishedEvent(
  overrides: Partial<Extract<CaptureEventInput, { type: 'npm.package.published' }>> = {},
): CaptureEventInput {
  return {
    type: 'npm.package.published',
    projectId: PROJECT_A,
    sourceId: SOURCE,
    packageKey: '@acme/widget',
    packageName: '@acme/widget',
    version: '1.0.0',
    data: {},
    ...overrides,
  };
}

export interface FixturePlan extends CaptureInput {
  readonly ulid: () => string;
  /** The id the first event will get. */
  readonly firstEventId: string;
}

export function capturePlan(
  _ctx: OrgContext,
  events: readonly CaptureEventInput[],
  operationId = ulid(),
): FixturePlan {
  const ids = Array.from({ length: events.length + 2 }, () => ulid());
  let next = 0;
  return {
    operationId,
    occurredAt: NOW,
    events,
    firstEventId: ids[0]!,
    ulid: () => ids.at(next++ % ids.length)!,
  };
}
