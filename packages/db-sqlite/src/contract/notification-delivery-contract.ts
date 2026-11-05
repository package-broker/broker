import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  type NotificationSettle,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createNotificationPrepareRepository } from '../repositories/notification-prepare.js';
import { createNotificationAttemptRepository } from '../repositories/notification-attempt.js';
import { notificationCaptureStatements } from '../repositories/notification-capture.js';
import { createNotificationDispatchRepository } from '../repositories/notification-dispatch.js';
import type { OpenedNotificationOrgs } from './notification-read-contract.js';
import {
  PROJECT_A,
  PROJECT_B,
  SOURCE,
  capturePlan,
  publishedEvent,
  rows,
  run,
  seedEndpoint,
  seedNotificationWorld,
} from './notification-fixture.js';

const LATER = '2026-11-01T12:00:01.000Z';
const ENDPOINTS = Array.from({ length: 7 }, (_, i) => `01J0EEEEEEEEEEEEEEEEEEEEE${i}`);

async function lease(executor: SqlExecutor, ctx: OrgContext, id: string, fence = 1) {
  await run(
    executor,
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES (?, ?, 'core:notification-dispatch:v1', ?, 'running', 'owner', '2099-01-01T00:00:00.000Z', ?)
     ON CONFLICT (id) DO UPDATE SET state = 'running', lease_owner = 'owner',
       lease_until = '2099-01-01T00:00:00.000Z', fence = excluded.fence`,
    id,
    ctx.orgId,
    `lease:${id}`,
    fence,
  );
  return { id, owner: 'owner', fence };
}

async function capture(executor: SqlExecutor, ctx: OrgContext, versions = ['1.0.0']) {
  const plan = capturePlan(
    ctx,
    versions.map((version) => publishedEvent({ version })),
  );
  await executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
  return plan;
}

async function deliveries(executor: SqlExecutor, ctx: OrgContext) {
  return rows<Record<string, unknown>>(
    executor,
    'SELECT * FROM notification_delivery WHERE org_id = ? ORDER BY endpoint_id, created_at, id',
    ctx.orgId,
  );
}

function audit(
  action: 'notification.delivery_started' | 'notification.delivery_finished',
  delivery: Record<string, unknown>,
  attempt: number,
  extra: Record<string, unknown> = {},
): AuditEvent {
  const fields = {
    endpoint_id: delivery.endpoint_id,
    event_id: delivery.event_id,
    delivery_id: delivery.id,
    attempt,
    ...extra,
  };
  const result = auditEvent({
    id: ulid(),
    now: LATER,
    action,
    actor: { type: 'system', id: null },
    target: { type: 'notification_delivery', id: String(delivery.id) },
    projectId: String(delivery.project_id),
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    changes: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { new: value as string }]),
    ),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.event;
}

function recording(executor: SqlExecutor) {
  const batches: (readonly Statement[])[] = [];
  return {
    batches,
    executor: {
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements: readonly Statement[]) => {
        batches.push(statements);
        return executor.batch(statements);
      },
    } as SqlExecutor,
  };
}

export function describeNotificationDeliveryContract(
  name: string,
  open: () => Promise<OpenedNotificationOrgs>,
): void {
  async function world(
    endpoints: number,
    body: (executor: SqlExecutor, ctx: OrgContext) => Promise<void>,
  ) {
    const opened = await open();
    try {
      const ctx = opened.orgs.a;
      await seedNotificationWorld(opened.executor, ctx);
      for (const id of ENDPOINTS.slice(0, endpoints))
        await seedEndpoint(opened.executor, ctx, { id });
      await body(opened.executor, ctx);
    } finally {
      await opened.close();
    }
  }

  /** Dispatches the operation and leases every delivery job with the given fence. */
  async function scheduled(executor: SqlExecutor, ctx: OrgContext, versions = ['1.0.0']) {
    const plan = await capture(executor, ctx, versions);
    const repo = createNotificationDispatchRepository(executor);
    const dispatcher = await lease(executor, ctx, 'dispatch-job');
    while (!(await repo.dispatchPage(ctx, dispatcher, plan.operationId)).done);
    return deliveries(executor, ctx);
  }

  describe(`notification dispatch: ${name}`, () => {
    it('schedules the snapshot five recipients per page and marks the event dispatched last', async () => {
      await world(7, async (executor, ctx) => {
        const plan = await capture(executor, ctx);
        const recorded = recording(executor);
        const repo = createNotificationDispatchRepository(recorded.executor);
        const dispatcher = await lease(executor, ctx, 'dispatch-job');
        const first = await repo.dispatchPage(ctx, dispatcher, plan.operationId);
        expect(first.jobIds).toHaveLength(5);
        expect(first.done).toBe(false);
        expect(
          await rows(
            executor,
            'SELECT dispatched_at FROM notification_event WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ dispatched_at: null }]);
        await seedEndpoint(executor, ctx, { id: '01J0EEEEEEEEEEEEEEEEEEEEEZ' });
        const second = await repo.dispatchPage(ctx, dispatcher, plan.operationId);
        expect(second).toMatchObject({ done: true });
        expect(second.jobIds).toHaveLength(2);
        expect(await repo.dispatchPage(ctx, dispatcher, plan.operationId)).toEqual({
          jobIds: [],
          done: true,
        });
        for (const batch of recorded.batches) expect(batch.length).toBeLessThanOrEqual(40);
        const all = await deliveries(executor, ctx);
        expect(all).toHaveLength(7);
        expect(new Set(all.map((d) => d.active_job_id)).size).toBe(7);
        const jobs = await rows<{ id: string; payload_json: string; resource_key: string }>(
          executor,
          "SELECT id, payload_json, resource_key FROM job WHERE org_id = ? AND type = 'core:notification-deliver:v1'",
          ctx.orgId,
        );
        expect(jobs).toHaveLength(7);
        for (const delivery of all) {
          const job = jobs.find((j) => j.id === delivery.active_job_id)!;
          expect(job.payload_json).toBe(`{"deliveryId":"${String(delivery.id)}"}`);
          expect(job.resource_key).toBe(`notification:${String(delivery.endpoint_id)}`);
        }
        const [event] = await rows<{ dispatched_at: string | null }>(
          executor,
          'SELECT dispatched_at FROM notification_event WHERE org_id = ?',
          ctx.orgId,
        );
        expect(event!.dispatched_at).not.toBeNull();
      });
    });

    it('refuses a stale dispatch lease without scheduling anything', async () => {
      await world(2, async (executor, ctx) => {
        const plan = await capture(executor, ctx);
        await lease(executor, ctx, 'dispatch-job', 3);
        await expect(
          createNotificationDispatchRepository(executor).dispatchPage(
            ctx,
            { id: 'dispatch-job', owner: 'owner', fence: 2 },
            plan.operationId,
          ),
        ).rejects.toMatchObject({ code: 'conflict' });
        expect((await deliveries(executor, ctx)).every((d) => d.active_job_id === null)).toBe(true);
      });
    });

    it('reuses an existing delivery job instead of duplicating it on replay', async () => {
      await world(1, async (executor, ctx) => {
        const plan = await capture(executor, ctx);
        const repo = createNotificationDispatchRepository(executor);
        const dispatcher = await lease(executor, ctx, 'dispatch-job');
        const [scheduled] = (await repo.dispatchPage(ctx, dispatcher, plan.operationId)).jobIds;
        await run(
          executor,
          'UPDATE notification_delivery SET active_job_id = NULL WHERE org_id = ?',
          ctx.orgId,
        );
        await run(
          executor,
          'UPDATE notification_event SET dispatched_at = NULL WHERE org_id = ?',
          ctx.orgId,
        );
        expect((await repo.dispatchPage(ctx, dispatcher, plan.operationId)).jobIds).toEqual([
          scheduled,
        ]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM job WHERE org_id = ? AND type = 'core:notification-deliver:v1'",
            ctx.orgId,
          ),
        ).toEqual([{ n: 1 }]);
      });
    });
  });

  describe(`notification attempts: ${name}`, () => {
    it('reports the reserved attempt and revision even when the delivery changes right after', async () => {
      await world(1, async (executor, ctx) => {
        const [delivery] = await scheduled(executor, ctx);
        const job = await lease(executor, ctx, String(delivery!.active_job_id));
        const racing = createNotificationAttemptRepository({
          driver: executor.driver,
          all: executor.all.bind(executor),
          batch: async (statements: readonly Statement[]) => {
            const results = await executor.batch(statements);
            await run(
              executor,
              'UPDATE notification_delivery SET revision = revision + 5 WHERE org_id = ?',
              ctx.orgId,
            );
            return results;
          },
        } as SqlExecutor);
        expect(
          await racing.reserve(ctx, job, {
            deliveryId: String(delivery!.id),
            expectedRevision: 1,
            now: LATER,
            event: audit('notification.delivery_started', delivery!, 1),
          }),
        ).toEqual({ ok: true, attempt: 1, revision: 2 });
      });
    });

    it('reserves an attempt with its started row and audit before any send', async () => {
      await world(1, async (executor, ctx) => {
        const [delivery] = await scheduled(executor, ctx);
        const repo = createNotificationAttemptRepository(executor);
        const job = await lease(executor, ctx, String(delivery!.active_job_id));
        expect(
          await repo.reserve(ctx, job, {
            deliveryId: String(delivery!.id),
            expectedRevision: 1,
            now: LATER,
            event: audit('notification.delivery_started', delivery!, 1),
          }),
        ).toEqual({ ok: true, attempt: 1, revision: 2 });
        expect(await repo.load(ctx, String(delivery!.id))).toMatchObject({
          state: 'sending',
          attempts: 1,
          activeFence: 1,
        });
        expect(
          await rows(
            executor,
            'SELECT attempt, outcome, job_id, fence FROM notification_attempt WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ attempt: 1, outcome: 'started', job_id: job.id, fence: 1 }]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM audit_pending WHERE org_id = ? AND action = 'notification.delivery_started'",
            ctx.orgId,
          ),
        ).toEqual([{ n: 1 }]);
      });
    });

    it('lets one endpoint send one delivery at a time while another endpoint proceeds', async () => {
      await world(2, async (executor, ctx) => {
        const all = await scheduled(executor, ctx, ['1.0.0', '1.0.1']);
        const repo = createNotificationAttemptRepository(executor);
        const reserve = async (delivery: Record<string, unknown>) =>
          repo.reserve(ctx, await lease(executor, ctx, String(delivery.active_job_id)), {
            deliveryId: String(delivery.id),
            expectedRevision: 1,
            now: LATER,
            event: audit('notification.delivery_started', delivery, 1),
          });
        const [a1, a2, b1] = all;
        expect((await reserve(a1!)).ok).toBe(true);
        await run(
          executor,
          "UPDATE job SET state = 'queued', lease_owner = NULL, lease_until = NULL WHERE id = ?",
          String(a1!.active_job_id),
        );
        expect((await reserve(a2!)).ok).toBe(false);
        expect((await reserve(b1!)).ok).toBe(true);
      });
    });

    it('refuses a ninth start, an expired or early delivery, a stale lease and a changed endpoint', async () => {
      await world(1, async (executor, ctx) => {
        const [delivery] = await scheduled(executor, ctx);
        const repo = createNotificationAttemptRepository(executor);
        const id = String(delivery!.id);
        const job = await lease(executor, ctx, String(delivery!.active_job_id), 2);
        const reserve = (attempt: number, guard = job) =>
          repo.reserve(ctx, guard, {
            deliveryId: id,
            expectedRevision: 1,
            now: LATER,
            event: audit('notification.delivery_started', delivery!, attempt),
          });
        const set = (assignment: string) =>
          run(
            executor,
            `UPDATE notification_delivery SET ${assignment} WHERE org_id = ?`,
            ctx.orgId,
          );
        await set('attempts = 8');
        expect(await reserve(8)).toEqual({ ok: false });
        await set("attempts = 0, expires_at = '2026-11-01T12:00:00.500Z'");
        expect(await reserve(1)).toEqual({ ok: false });
        await set(
          "expires_at = '2026-11-02T12:00:00.000Z', next_attempt_at = '2026-11-01T13:00:00.000Z'",
        );
        expect(await reserve(1)).toEqual({ ok: false });
        await set("next_attempt_at = '2026-11-01T12:00:00.000Z'");
        expect(await reserve(1, { ...job, fence: 1 })).toEqual({ ok: false });
        await run(
          executor,
          'UPDATE notification_endpoint SET revision = 2 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await reserve(1)).toEqual({ ok: false });
        await run(
          executor,
          'UPDATE notification_endpoint SET revision = 1 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await reserve(2)).toEqual({ ok: false });
        expect(await repo.load(ctx, id)).toMatchObject({ state: 'pending', attempts: 0 });
        expect(await reserve(1)).toMatchObject({ ok: true, attempt: 1 });
      });
    });

    it.each(['detached', 'paused', 'foreign-source', 'other-project-owner'])(
      'rechecks source admission inside reservation after preparation: %s',
      async (change) => {
        await world(1, async (executor, ctx) => {
          const [delivery] = await scheduled(executor, ctx);
          const attempts = createNotificationAttemptRepository(executor);
          const guard = await lease(executor, ctx, String(delivery!.active_job_id));
          expect(
            await createNotificationPrepareRepository(executor).context(ctx, String(delivery!.id)),
          ).toMatchObject({ delivery: { state: 'pending' }, admitted: true });
          let changed = false;
          // Change admission immediately before the reservation batch, after every context read.
          const racing: SqlExecutor = {
            driver: executor.driver,
            all: executor.all.bind(executor),
            async batch(statements) {
              if (!changed) {
                changed = true;
                if (change === 'detached')
                  await run(
                    executor,
                    'DELETE FROM project_source WHERE org_id = ? AND project_id = ? AND source_id = ?',
                    ctx.orgId,
                    PROJECT_A,
                    SOURCE,
                  );
                else if (change === 'paused')
                  await run(
                    executor,
                    "UPDATE source SET status = 'paused' WHERE org_id = ? AND id = ?",
                    ctx.orgId,
                    SOURCE,
                  );
                else if (change === 'other-project-owner')
                  await run(
                    executor,
                    'UPDATE source SET project_id = ? WHERE org_id = ? AND id = ?',
                    PROJECT_B,
                    ctx.orgId,
                    SOURCE,
                  );
                else {
                  const [foreign] = await rows<{ id: string }>(
                    executor,
                    'SELECT id FROM organization WHERE id <> ?',
                    ctx.orgId,
                  );
                  await run(
                    executor,
                    "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('foreign-source', ?, 'Foreign', 'npm', 'hosted')",
                    foreign!.id,
                  );
                  await run(
                    executor,
                    "UPDATE notification_event SET source_id = 'foreign-source' WHERE org_id = ?",
                    ctx.orgId,
                  );
                }
              }
              return executor.batch(statements);
            },
          };
          expect(
            await createNotificationAttemptRepository(racing).reserve(ctx, guard, {
              deliveryId: String(delivery!.id),
              expectedRevision: 1,
              now: LATER,
              event: audit('notification.delivery_started', delivery!, 1),
            }),
          ).toEqual({ ok: false });
          expect(await attempts.load(ctx, String(delivery!.id))).toMatchObject({
            state: 'pending',
            attempts: 0,
          });
          expect(
            await rows(executor, 'SELECT * FROM notification_attempt WHERE org_id = ?', ctx.orgId),
          ).toEqual([]);
        });
      },
    );

    it('rolls the reservation back when its audit cannot be written', async () => {
      await world(1, async (executor, ctx) => {
        const [delivery] = await scheduled(executor, ctx);
        const repo = createNotificationAttemptRepository(executor);
        const job = await lease(executor, ctx, String(delivery!.active_job_id));
        const event = audit('notification.delivery_started', delivery!, 1);
        await run(
          executor,
          `INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json)
           VALUES (?, ?, ?, 'system', NULL, NULL, NULL, 'notification.delivery_started', 'x', NULL, NULL, '{}')`,
          event.id,
          ctx.orgId,
          LATER,
        );
        await expect(
          repo.reserve(ctx, job, {
            deliveryId: String(delivery!.id),
            expectedRevision: 1,
            now: LATER,
            event,
          }),
        ).rejects.toThrow();
        expect(await repo.load(ctx, String(delivery!.id))).toMatchObject({
          state: 'pending',
          attempts: 0,
        });
        expect(
          await rows(
            executor,
            'SELECT count(*) AS n FROM notification_attempt WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ n: 0 }]);
      });
    });
  });

  describe(`notification settlement: ${name}`, () => {
    async function started(executor: SqlExecutor, ctx: OrgContext, versions = ['1.0.0']) {
      const all = await scheduled(executor, ctx, versions);
      const repo = createNotificationAttemptRepository(executor);
      const delivery = all[0]!;
      const job = await lease(executor, ctx, String(delivery.active_job_id));
      await repo.reserve(ctx, job, {
        deliveryId: String(delivery.id),
        expectedRevision: 1,
        now: LATER,
        event: audit('notification.delivery_started', delivery, 1),
      });
      return { repo, delivery, job, all };
    }

    function settle(
      delivery: Record<string, unknown>,
      over: Partial<NotificationSettle> = {},
    ): NotificationSettle {
      return {
        deliveryId: String(delivery.id),
        attempt: 1,
        expectedRevision: 2,
        now: LATER,
        outcome: 'failed',
        code: 'http_permanent',
        status: 400,
        durationMs: 12,
        delivery: { state: 'failed', code: 'http_permanent' },
        disable: null,
        event: audit('notification.delivery_finished', delivery, 1, {
          outcome: 'failed',
          reason: 'http_permanent',
          status: 400,
          duration_ms: 12,
          delivery_state: 'failed',
        }),
        ...over,
      };
    }

    async function endpoint(executor: SqlExecutor, ctx: OrgContext) {
      const [row] = await rows(
        executor,
        'SELECT state, disabled_reason, failure_streak, revision FROM notification_endpoint WHERE org_id = ? ORDER BY id LIMIT 1',
        ctx.orgId,
      );
      return row;
    }

    it('records a delivered attempt and resets the streak of the same endpoint revision', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 4 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(
          await repo.settle(
            ctx,
            job,
            settle(delivery, {
              outcome: 'delivered',
              code: 'ok',
              status: 204,
              delivery: { state: 'delivered', code: 'ok' },
            }),
          ),
        ).toBe(true);
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({
          state: 'delivered',
          activeFence: null,
        });
        expect(await endpoint(executor, ctx)).toMatchObject({ failure_streak: 0 });
        expect(
          await rows(
            executor,
            'SELECT outcome, status, duration_ms FROM notification_attempt WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ outcome: 'delivered', status: 204, duration_ms: 12 }]);
      });
    });

    it('lets neither a stale fence settle nor an old endpoint revision touch the streak', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        expect(await repo.settle(ctx, { ...job, fence: 9 }, settle(delivery))).toBe(false);
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({ state: 'sending' });
        await run(
          executor,
          'UPDATE notification_endpoint SET revision = 5, failure_streak = 3 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await repo.settle(ctx, job, settle(delivery))).toBe(true);
        expect(await endpoint(executor, ctx)).toMatchObject({ failure_streak: 3, revision: 5 });
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 0 WHERE org_id = ?',
          ctx.orgId,
        );
      });
    });

    it('counts a terminal failure and disables on the tenth, cancelling waiting work', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job, all } = await started(executor, ctx, ['1.0.0', '1.0.1']);
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 9 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await repo.settle(ctx, job, settle(delivery))).toBe(true);
        expect(await endpoint(executor, ctx)).toMatchObject({
          state: 'disabled',
          disabled_reason: 'failures',
          failure_streak: 10,
          revision: 2,
        });
        expect(await repo.load(ctx, String(all[1]!.id))).toMatchObject({ state: 'cancelled' });
        const [disabled] = await rows<{ payload_json: string; actor_type: string }>(
          executor,
          "SELECT payload_json, actor_type FROM audit_pending WHERE org_id = ? AND action = 'notification.auto_disable'",
          ctx.orgId,
        );
        expect(disabled!.actor_type).toBe('system');
        expect(JSON.parse(disabled!.payload_json)).toMatchObject({
          changes: { reason: { new: 'failures' }, failure_streak: { new: 10 } },
        });
      });
    });

    it('counts a failure below the limit without disabling', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 8 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await repo.settle(ctx, job, settle(delivery))).toBe(true);
        expect(await endpoint(executor, ctx)).toMatchObject({
          state: 'enabled',
          failure_streak: 9,
        });
      });
    });

    it.each(['credentials', 'policy', 'gone'] as const)(
      'disables immediately for %s',
      async (reason) => {
        await world(1, async (executor, ctx) => {
          const { repo, delivery, job } = await started(executor, ctx);
          expect(await repo.settle(ctx, job, settle(delivery, { disable: reason }))).toBe(true);
          expect(await endpoint(executor, ctx)).toMatchObject({
            state: 'disabled',
            disabled_reason: reason,
          });
        });
      },
    );

    it('keeps a retry pending at its persisted due time without touching the streak', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        expect(
          await repo.settle(
            ctx,
            job,
            settle(delivery, {
              outcome: 'retry',
              code: 'http_retry',
              status: 503,
              delivery: { state: 'pending', nextAttemptAt: '2026-11-01T12:05:00.000Z' },
            }),
          ),
        ).toBe(true);
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({
          state: 'pending',
          nextAttemptAt: '2026-11-01T12:05:00.000Z',
          lastFinishedAt: LATER,
          attempts: 1,
        });
        expect(await endpoint(executor, ctx)).toMatchObject({ failure_streak: 0 });
      });
    });

    it('turns an attempt a crashed claim started into unknown and retries it', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        const reclaimed = await lease(executor, ctx, job.id, 2);
        const event = audit('notification.delivery_finished', delivery, 1, {
          outcome: 'unknown',
          reason: 'unknown',
          status: null,
          delivery_state: 'pending',
        });
        const reconcile = {
          deliveryId: String(delivery.id),
          now: LATER,
          delivery: { state: 'pending' as const, nextAttemptAt: '2026-11-01T12:05:00.000Z' },
          event,
        };
        expect(await repo.reconcile(ctx, job, reconcile)).toBe(false);
        await run(
          executor,
          'UPDATE notification_delivery SET active_fence = 2 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await repo.reconcile(ctx, reclaimed, reconcile)).toBe(false);
        await run(
          executor,
          'UPDATE notification_delivery SET active_fence = 1 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await repo.settle(ctx, reclaimed, settle(delivery))).toBe(false);
        expect(await repo.reconcile(ctx, reclaimed, reconcile)).toBe(true);
        expect(
          await rows(
            executor,
            'SELECT outcome FROM notification_attempt WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ outcome: 'unknown' }]);
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({
          state: 'pending',
          attempts: 1,
        });
        expect(await endpoint(executor, ctx)).toMatchObject({ failure_streak: 0 });
        await run(
          executor,
          'UPDATE notification_delivery SET next_attempt_at = ? WHERE org_id = ?',
          LATER,
          ctx.orgId,
        );
        const current = (await repo.load(ctx, String(delivery.id)))!;
        expect(
          await repo.reserve(ctx, reclaimed, {
            deliveryId: current.id,
            expectedRevision: current.revision,
            now: LATER,
            event: audit('notification.delivery_started', delivery, 2),
          }),
        ).toMatchObject({ ok: true, attempt: 2 });
      });
    });

    /** Runs `edit` right after the repository's first read, before its batch commits. */
    function editedAfterRead(executor: SqlExecutor, edit: () => Promise<void>): SqlExecutor {
      let pending = true;
      return {
        driver: executor.driver,
        all: async <R>(statement: Statement) => {
          const result = await executor.all<R>(statement);
          if (pending) {
            pending = false;
            await edit();
          }
          return result;
        },
        batch: (statements: readonly Statement[]) => executor.batch(statements),
      } as SqlExecutor;
    }

    it.each(['credentials', 'policy', 'gone'] as const)(
      'disables for %s even when the streak changes concurrently',
      async (reason) => {
        await world(1, async (executor, ctx) => {
          const { delivery, job } = await started(executor, ctx);
          const racing = createNotificationAttemptRepository(
            editedAfterRead(executor, () =>
              run(
                executor,
                'UPDATE notification_endpoint SET failure_streak = 3 WHERE org_id = ?',
                ctx.orgId,
              ),
            ),
          );
          expect(await racing.settle(ctx, job, settle(delivery, { disable: reason }))).toBe(true);
          expect(await endpoint(executor, ctx)).toMatchObject({
            state: 'disabled',
            disabled_reason: reason,
            failure_streak: 4,
            revision: 2,
          });
          const [disabled] = await rows<{ payload_json: string }>(
            executor,
            "SELECT payload_json FROM audit_pending WHERE org_id = ? AND action = 'notification.auto_disable'",
            ctx.orgId,
          );
          expect(JSON.parse(disabled!.payload_json)).toMatchObject({
            changes: {
              revision: { old: 1, new: 2 },
              reason: { new: reason },
              failure_streak: { new: 4 },
            },
          });
        });
      },
    );

    it('counts the failure on the committed streak when it changes concurrently', async () => {
      await world(1, async (executor, ctx) => {
        const { delivery, job } = await started(executor, ctx);
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 8 WHERE org_id = ?',
          ctx.orgId,
        );
        const racing = createNotificationAttemptRepository(
          editedAfterRead(executor, () =>
            run(
              executor,
              'UPDATE notification_endpoint SET failure_streak = 9 WHERE org_id = ?',
              ctx.orgId,
            ),
          ),
        );
        expect(await racing.settle(ctx, job, settle(delivery))).toBe(true);
        expect(await endpoint(executor, ctx)).toMatchObject({
          state: 'disabled',
          disabled_reason: 'failures',
          failure_streak: 10,
        });
      });
    });

    it('leaves the streak alone when the endpoint revision changes concurrently', async () => {
      await world(1, async (executor, ctx) => {
        const { delivery, job } = await started(executor, ctx);
        const racing = createNotificationAttemptRepository(
          editedAfterRead(executor, () =>
            run(
              executor,
              'UPDATE notification_endpoint SET revision = 2 WHERE org_id = ?',
              ctx.orgId,
            ),
          ),
        );
        expect(await racing.settle(ctx, job, settle(delivery, { disable: 'credentials' }))).toBe(
          true,
        );
        expect(await endpoint(executor, ctx)).toMatchObject({
          state: 'enabled',
          failure_streak: 0,
          revision: 2,
        });
        expect(
          await rows(
            executor,
            "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'notification.auto_disable'",
            ctx.orgId,
          ),
        ).toEqual([]);
      });
    });

    it.each([
      [
        'a retry',
        {
          outcome: 'retry' as const,
          code: 'http_retry' as const,
          delivery: { state: 'pending' as const, nextAttemptAt: '2026-11-01T12:05:00.000Z' },
        },
      ],
      ['an unknown outcome', { outcome: 'unknown' as const, code: 'unknown' as const }],
      [
        'a delivered attempt',
        {
          outcome: 'delivered' as const,
          code: 'ok' as const,
          delivery: { state: 'delivered' as const, code: 'ok' as const },
        },
      ],
    ])('refuses an immediate disable with %s before any write', async (_label, over) => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        await expect(
          repo.settle(ctx, job, settle(delivery, { ...over, disable: 'credentials' })),
        ).rejects.toMatchObject({ code: 'invalid_request' });
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({ state: 'sending' });
        expect(await endpoint(executor, ctx)).toMatchObject({ state: 'enabled' });
      });
    });

    it('counts a retryable last attempt that ends the delivery at its attempt limit', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        const input = settle(delivery, {
          outcome: 'retry',
          code: 'http_retry',
          status: 503,
          delivery: { state: 'failed', code: 'attempt_limit' },
        });
        expect(await repo.settle(ctx, job, input)).toBe(true);
        expect(await endpoint(executor, ctx)).toMatchObject({
          state: 'enabled',
          failure_streak: 1,
        });
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({ state: 'failed' });
      });
    });

    it('refuses an attempt number above the attempt limit before any write', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        await expect(
          repo.settle(ctx, job, settle(delivery, { attempt: MAX_NOTIFICATION_ATTEMPTS + 1 })),
        ).rejects.toMatchObject({ code: 'invalid_request' });
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({ state: 'sending' });
      });
    });

    it('rolls settlement back when its audit cannot be written', async () => {
      await world(1, async (executor, ctx) => {
        const { repo, delivery, job } = await started(executor, ctx);
        const input = settle(delivery);
        await run(
          executor,
          `INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json)
           VALUES (?, ?, ?, 'system', NULL, NULL, NULL, 'notification.delivery_finished', 'x', NULL, NULL, '{}')`,
          input.event.id,
          ctx.orgId,
          LATER,
        );
        await expect(repo.settle(ctx, job, input)).rejects.toThrow();
        expect(await repo.load(ctx, String(delivery.id))).toMatchObject({ state: 'sending' });
        expect(
          await rows(
            executor,
            'SELECT outcome FROM notification_attempt WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ outcome: 'started' }]);
      });
    });
  });
}
