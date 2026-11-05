import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { MAX_NOTIFICATION_ATTEMPTS } from '@package-broker/core/db/notifications';
import {
  CAPTURE_PRUNE_LIMIT,
  MAX_RETAINED_DELIVERIES,
  notificationCaptureStatements,
} from '../repositories/notification-capture.js';
import type { OpenedNotificationOrgs } from './notification-read-contract.js';
import {
  NOW,
  PROJECT_A,
  PROJECT_B,
  capturePlan,
  type FixturePlan,
  publishedEvent,
  rows,
  run,
  seedEndpoint,
  seedNotificationWorld,
} from './notification-fixture.js';

const MUTATED = sql<boolean>`exists (select 1 from project where id = ${PROJECT_A} and name = 'mutated')`;

function domain(ctx: OrgContext, succeeds = true): Statement {
  return {
    sql: `UPDATE project SET name = 'mutated' WHERE org_id = ? AND id = ? AND ${succeeds ? '1' : '0'}`,
    params: [ctx.orgId, PROJECT_A],
  };
}

async function capture(
  executor: SqlExecutor,
  ctx: OrgContext,
  plan: FixturePlan,
  options: { succeeds?: boolean; fail?: boolean } = {},
) {
  await executor.batch([
    domain(ctx, options.succeeds ?? true),
    ...notificationCaptureStatements(ctx, plan, MUTATED),
    ...(options.fail ? [{ sql: 'INSERT INTO organization (id) VALUES (NULL)', params: [] }] : []),
  ]);
}

async function counts(executor: SqlExecutor, ctx: OrgContext) {
  const [row] = await rows<Record<string, number>>(
    executor,
    `SELECT (SELECT count(*) FROM notification_event WHERE org_id = ?) AS events,
      (SELECT count(*) FROM notification_delivery WHERE org_id = ?) AS deliveries,
      (SELECT count(*) FROM job WHERE org_id = ? AND type = 'core:notification-dispatch:v1') AS jobs,
      (SELECT count(*) FROM audit_pending WHERE org_id = ? AND action = 'notification.overflow') AS overflow,
      (SELECT count(*) FROM project WHERE id = ? AND name = 'mutated') AS mutated`,
    ctx.orgId,
    ctx.orgId,
    ctx.orgId,
    ctx.orgId,
    PROJECT_A,
  );
  return row!;
}

/** `n` events, each with one delivery to endpoint E1 of project A, oldest first. */
async function fill(
  executor: SqlExecutor,
  ctx: OrgContext,
  n: number,
  state: 'pending' | 'delivered' | 'failed',
) {
  const finished =
    state === 'pending'
      ? 'NULL'
      : `strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', '-' || (20000 - i) || ' seconds')`;
  const rowsOf = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})`;
  const id = "'fill-' || substr('0000' || i, -5)";
  await run(
    executor,
    `${rowsOf} INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
     SELECT ?, ?, ${id}, ${id}, 'npm.package.published', 'S-hosted', 'x', '{}', ? FROM n`,
    ctx.orgId,
    PROJECT_A,
    NOW,
  );
  await run(
    executor,
    `${rowsOf} INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision,
       configuration_credential_id, state, outcome_code, next_attempt_at, expires_at, created_at, finished_at)
     SELECT ?, ?, ${id}, ${id}, 'E1', 1, 'C-E1', ?, ?, ?, ?, ?, ${finished} FROM n`,
    ctx.orgId,
    PROJECT_A,
    state,
    state === 'pending' ? null : state === 'delivered' ? 'ok' : 'network',
    NOW,
    NOW,
    NOW,
  );
}

export function describeNotificationCaptureContract(
  name: string,
  open: () => Promise<OpenedNotificationOrgs>,
): void {
  async function world(body: (executor: SqlExecutor, ctx: OrgContext) => Promise<void>) {
    const opened = await open();
    try {
      await seedNotificationWorld(opened.executor, opened.orgs.a);
      await body(opened.executor, opened.orgs.a);
    } finally {
      await opened.close();
    }
  }

  describe(`notification capture: ${name}`, () => {
    it('does not audit overflow on a replay with newly generated event IDs', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        const plan = capturePlan(ctx, [publishedEvent()]);
        await executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
        await executor.batch(
          notificationCaptureStatements(
            ctx,
            capturePlan(ctx, [publishedEvent()], plan.operationId),
            sql<boolean>`1`,
          ),
        );
        expect(await counts(executor, ctx)).toMatchObject({
          events: 1,
          deliveries: 1,
          overflow: 0,
        });
      });
    });

    it('commits the event, its recipient snapshot and one dispatch job with the mutation', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1', revision: 3 });
        const plan = capturePlan(ctx, [publishedEvent()]);
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toEqual({
          events: 1,
          deliveries: 1,
          jobs: 1,
          overflow: 0,
          mutated: 1,
        });
        const [delivery] = await rows(
          executor,
          'SELECT * FROM notification_delivery WHERE org_id = ?',
          ctx.orgId,
        );
        expect(delivery).toMatchObject({
          project_id: PROJECT_A,
          event_id: plan.firstEventId,
          endpoint_id: 'E1',
          endpoint_revision: 3,
          configuration_credential_id: 'C-E1',
          state: 'pending',
          attempts: 0,
          active_job_id: null,
          next_attempt_at: NOW,
          expires_at: '2026-11-02T12:00:00.000Z',
          created_at: NOW,
        });
        expect(String(delivery!.id)).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const [event] = await rows(
          executor,
          'SELECT * FROM notification_event WHERE org_id = ?',
          ctx.orgId,
        );
        expect(event).toMatchObject({
          operation_id: plan.operationId,
          package_key: '@acme/widget',
          source_id: 'S-hosted',
          dispatched_at: null,
        });
        expect(JSON.parse(String(event!.payload_json))).toEqual({
          schemaVersion: 1,
          id: plan.firstEventId,
          type: 'npm.package.published',
          occurredAt: NOW,
          operationId: plan.operationId,
          organizationId: ctx.orgId,
          projectId: PROJECT_A,
          package: { ecosystem: 'npm', name: '@acme/widget', version: '1.0.0' },
          data: {},
        });
        const [job] = await rows(
          executor,
          "SELECT payload_json, project_id FROM job WHERE org_id = ? AND type = 'core:notification-dispatch:v1'",
          ctx.orgId,
        );
        expect(job).toEqual({
          payload_json: `{"operationId":"${plan.operationId}"}`,
          project_id: null,
        });
      });
    });

    it('inserts nothing when the mutation did not happen', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]), { succeeds: false });
        expect(await counts(executor, ctx)).toEqual({
          events: 0,
          deliveries: 0,
          jobs: 0,
          overflow: 0,
          mutated: 0,
        });
      });
    });

    it('rolls back the mutation, event, deliveries and job together on a later failure', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await expect(
          capture(executor, ctx, capturePlan(ctx, [publishedEvent()]), { fail: true }),
        ).rejects.toThrow();
        expect(await counts(executor, ctx)).toEqual({
          events: 0,
          deliveries: 0,
          jobs: 0,
          overflow: 0,
          mutated: 0,
        });
      });
    });

    it('selects only enabled endpoints of the originating project that pick the type and key', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'match', pattern: '@acme/*' });
        await seedEndpoint(executor, ctx, { id: 'exact', pattern: '@acme/!widget' });
        await seedEndpoint(executor, ctx, { id: 'other-project', projectId: PROJECT_B });
        await seedEndpoint(executor, ctx, { id: 'disabled', state: 'disabled' });
        await seedEndpoint(executor, ctx, { id: 'deleted', state: 'deleted' });
        await seedEndpoint(executor, ctx, { id: 'other-type', events: ['npm.package.released'] });
        await seedEndpoint(executor, ctx, { id: 'display-name', pattern: '@acme/Widget' });
        await seedEndpoint(executor, ctx, { id: 'prefix', pattern: '@acme/w' });
        await capture(
          executor,
          ctx,
          capturePlan(ctx, [
            publishedEvent({ packageKey: '@acme/!widget', packageName: '@acme/Widget' }),
          ]),
        );
        expect(
          (
            await rows<{ endpoint_id: string }>(
              executor,
              'SELECT endpoint_id FROM notification_delivery WHERE org_id = ? ORDER BY endpoint_id',
              ctx.orgId,
            )
          ).map((row) => row.endpoint_id),
        ).toEqual(['exact', 'match']);
      });
    });

    it('creates no event or job when no endpoint is eligible', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'other-project', projectId: PROJECT_B });
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        expect(await counts(executor, ctx)).toMatchObject({ events: 0, jobs: 0, mutated: 1 });
      });
    });

    it('refuses a project that lost the source, a paused source and an archived project', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await run(
          executor,
          'DELETE FROM project_source WHERE org_id = ? AND project_id = ?',
          ctx.orgId,
          PROJECT_A,
        );
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        await run(
          executor,
          'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
          ctx.orgId,
          PROJECT_A,
          'S-hosted',
        );
        await run(executor, "UPDATE source SET status = 'paused' WHERE org_id = ?", ctx.orgId);
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        await run(executor, "UPDATE source SET status = 'active' WHERE org_id = ?", ctx.orgId);
        await run(executor, "UPDATE project SET status = 'archived' WHERE id = ?", PROJECT_A);
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        expect(await counts(executor, ctx)).toMatchObject({ events: 0, deliveries: 0, jobs: 0 });
      });
    });

    it('deduplicates a repeated operation and never adds later endpoints to an old event', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        const plan = capturePlan(ctx, [publishedEvent()]);
        await capture(executor, ctx, plan);
        await seedEndpoint(executor, ctx, { id: 'E2' });
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()], plan.operationId));
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toMatchObject({
          events: 1,
          deliveries: 1,
          jobs: 1,
        });
      });
    });

    it('captures one event per changed item under one operation', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, {
          id: 'E1',
          events: ['npm.package.deprecation_changed'],
        });
        const plan = capturePlan(
          ctx,
          ['1.0.0', '1.1.0', '2.0.0'].map((version) => ({
            type: 'npm.package.deprecation_changed' as const,
            projectId: PROJECT_A,
            sourceId: 'S-hosted',
            packageKey: '@acme/widget',
            packageName: '@acme/widget',
            version,
            data: { deprecated: true },
          })),
        );
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toMatchObject({ events: 3, deliveries: 3, jobs: 1 });
        expect(
          await rows(
            executor,
            'SELECT DISTINCT operation_id FROM notification_event WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ operation_id: plan.operationId }]);
      });
    });

    it('standalone overflow stays ordinary and rolls back under required refusal', () =>
      world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 10000, 'pending');
        await run(
          executor,
          "UPDATE audit_chain SET policy='required',capacity_state='refusing' WHERE org_id=?",
          ctx.orgId,
        );
        await expect(
          capture(executor, ctx, capturePlan(ctx, [publishedEvent()])),
        ).rejects.toMatchObject({ kind: 'backlog_full' });
        expect(await counts(executor, ctx)).toMatchObject({
          events: 10000,
          deliveries: 10000,
          overflow: 0,
          mutated: 0,
        });
      }));
    it('commits the mutation and one overflow audit when the organization is full', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 10_000, 'pending');
        const plan = capturePlan(ctx, [publishedEvent(), publishedEvent({ version: '1.0.1' })]);
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toEqual({
          events: 10000,
          deliveries: 10000,
          jobs: 0,
          overflow: 1,
          mutated: 1,
        });
        const [audit] = await rows<{ payload_json: string; actor_type: string }>(
          executor,
          "SELECT payload_json, actor_type FROM audit_pending WHERE org_id = ? AND action = 'notification.overflow'",
          ctx.orgId,
        );
        expect(audit!.actor_type).toBe('system');
        expect(JSON.parse(audit!.payload_json)).toMatchObject({
          changes: { event_count: { new: 2 } },
        });
      });
    });

    it('does not prune on a replay that will insert no notification work at capacity', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 9_999, 'delivered');
        const plan = capturePlan(ctx, [publishedEvent()]);
        await capture(executor, ctx, plan);
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()], plan.operationId));
        expect(await counts(executor, ctx)).toEqual({
          events: 10_000,
          deliveries: 10_000,
          jobs: 1,
          overflow: 0,
          mutated: 1,
        });
      });
    });

    it('keeps all 10,000 events and deliveries when all endpoints are disabled', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 10_000, 'delivered');
        await run(
          executor,
          "UPDATE notification_endpoint SET state = 'disabled', disabled_reason = 'manual' WHERE org_id = ?",
          ctx.orgId,
        );
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        expect(await counts(executor, ctx)).toEqual({
          events: 10_000,
          deliveries: 10_000,
          jobs: 0,
          overflow: 0,
          mutated: 1,
        });
      });
    });

    it('uses only eligible events when a mixed operation fills the last event slot', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 9_999, 'pending');
        await capture(
          executor,
          ctx,
          capturePlan(ctx, [
            publishedEvent(),
            publishedEvent({ projectId: PROJECT_B, version: '2.0.0' }),
          ]),
        );
        expect(await counts(executor, ctx)).toEqual({
          events: 10_000,
          deliveries: 10_000,
          jobs: 1,
          overflow: 0,
          mutated: 1,
        });
      });
    });

    it('prunes the oldest terminal history before admitting when the organization is full', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 10_000, 'delivered');
        await run(
          executor,
          `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
           SELECT org_id, project_id, id, 1, 'J', 1, 'delivered', 'ok', created_at, finished_at FROM notification_delivery WHERE org_id = ?`,
          ctx.orgId,
        );
        const plan = capturePlan(ctx, [publishedEvent(), publishedEvent({ version: '1.0.1' })]);
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toEqual({
          events: 10_000 - CAPTURE_PRUNE_LIMIT + 2,
          deliveries: 10_000 - CAPTURE_PRUNE_LIMIT + 2,
          jobs: 1,
          overflow: 0,
          mutated: 1,
        });
        const [kept] = await rows<Record<string, unknown>>(
          executor,
          `SELECT min(id) AS oldest, (SELECT count(*) FROM notification_attempt WHERE org_id = ?) AS attempts,
             (SELECT count(*) FROM notification_attempt a WHERE a.org_id = ? AND NOT EXISTS (
               SELECT 1 FROM notification_delivery d WHERE d.org_id = a.org_id AND d.id = a.delivery_id)) AS orphans
           FROM notification_delivery WHERE org_id = ? AND substr(id, 1, 5) = 'fill-'`,
          ctx.orgId,
          ctx.orgId,
          ctx.orgId,
        );
        expect(kept).toEqual({
          oldest: `fill-${String(CAPTURE_PRUNE_LIMIT + 1).padStart(5, '0')}`,
          attempts: 10_000 - CAPTURE_PRUNE_LIMIT,
          orphans: 0,
        });
      });
    });

    it('keeps terminal history while the organization has room', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 100, 'delivered');
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        expect(await counts(executor, ctx)).toMatchObject({ events: 101, deliveries: 101 });
      });
    });

    it('never prunes pending or sending deliveries to make room', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 10_000, 'pending');
        await run(
          executor,
          "UPDATE notification_delivery SET state = 'sending', active_job_id = 'J', active_fence = 1 WHERE org_id = ? AND id <= 'fill-05000'",
          ctx.orgId,
        );
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        expect(await counts(executor, ctx)).toMatchObject({
          events: 10_000,
          deliveries: 10_000,
          overflow: 1,
          mutated: 1,
        });
      });
    });

    it('reserves exactly the recipients the operation would get', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 9_999, 'pending');
        await seedEndpoint(executor, ctx, { id: 'E-disabled', state: 'disabled' });
        await seedEndpoint(executor, ctx, { id: 'E-other', projectId: PROJECT_B });
        await seedEndpoint(executor, ctx, { id: 'E-type', events: ['npm.package.released'] });
        await seedEndpoint(executor, ctx, { id: 'E-key', pattern: '@other/*' });
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent()]));
        expect(await counts(executor, ctx)).toMatchObject({
          events: 10_000,
          deliveries: 10_000,
          jobs: 1,
          overflow: 0,
        });
        await run(
          executor,
          "DELETE FROM notification_delivery WHERE org_id = ? AND id = 'fill-00001'",
          ctx.orgId,
        );
        await seedEndpoint(executor, ctx, { id: 'E2' });
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent({ version: '1.0.1' })]));
        expect(await counts(executor, ctx)).toMatchObject({
          deliveries: 9_999,
          overflow: 1,
          mutated: 1,
        });
      });
    });

    it('keeps two captures of one batch and of consecutive batches within the caps', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 9_999, 'pending');
        const first = capturePlan(ctx, [publishedEvent()]);
        const second = capturePlan(ctx, [publishedEvent({ version: '1.0.1' })]);
        await executor.batch([
          domain(ctx),
          ...notificationCaptureStatements(ctx, first, MUTATED),
          ...notificationCaptureStatements(ctx, second, MUTATED),
        ]);
        expect(await counts(executor, ctx)).toMatchObject({
          deliveries: 10_000,
          jobs: 1,
          overflow: 1,
          mutated: 1,
        });
        await capture(executor, ctx, capturePlan(ctx, [publishedEvent({ version: '1.0.2' })]));
        expect(await counts(executor, ctx)).toMatchObject({ deliveries: 10_000, overflow: 2 });
      });
    });

    it('bounds attempts at eight per delivery, so a full organization holds at most 80,000', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 1, 'failed');
        const insert = (attempt: number) =>
          run(
            executor,
            `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
             VALUES (?, ?, 'fill-00001', ?, 'J', 1, 'failed', 'network', ?, ?)`,
            ctx.orgId,
            PROJECT_A,
            attempt,
            NOW,
            NOW,
          );
        for (let attempt = 1; attempt <= 8; attempt += 1) await insert(attempt);
        await expect(insert(9)).rejects.toThrow();
        await expect(insert(8)).rejects.toThrow();
        expect(MAX_RETAINED_DELIVERIES * MAX_NOTIFICATION_ATTEMPTS).toBe(80_000);
      });
    });

    it('overflows an operation above the per-operation event cap', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        const plan = capturePlan(
          ctx,
          Array.from({ length: 65 }, (_, i) => publishedEvent({ version: `1.0.${i}` })),
        );
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toMatchObject({ events: 0, overflow: 1, mutated: 1 });
      });
    });

    it('prunes nothing for an operation above the per-operation cap, even in a full organization', async () => {
      await world(async (executor, ctx) => {
        await seedEndpoint(executor, ctx, { id: 'E1' });
        await fill(executor, ctx, 10_000, 'delivered');
        await capture(
          executor,
          ctx,
          capturePlan(
            ctx,
            Array.from({ length: 65 }, (_, i) => publishedEvent({ version: `2.0.${i}` })),
          ),
        );
        expect(await counts(executor, ctx)).toMatchObject({
          events: 10_000,
          deliveries: 10_000,
          overflow: 1,
          mutated: 1,
        });
      });
    });

    it('records no overflow when nobody would have received the event', async () => {
      await world(async (executor, ctx) => {
        const plan = capturePlan(
          ctx,
          Array.from({ length: 65 }, (_, i) => publishedEvent({ version: `1.0.${i}` })),
        );
        await capture(executor, ctx, plan);
        expect(await counts(executor, ctx)).toMatchObject({ events: 0, overflow: 0, mutated: 1 });
      });
    });

    it('stays within the D1 bound-parameter limit', async () => {
      await world(async (_executor, ctx) => {
        const plan = capturePlan(
          ctx,
          Array.from({ length: 64 }, (_, i) => publishedEvent({ version: `1.0.${i}` })),
        );
        for (const statement of notificationCaptureStatements(ctx, plan, MUTATED))
          expect(statement.params.length).toBeLessThanOrEqual(100);
      });
    });
  });
}
