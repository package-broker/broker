import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlExecutor, SqlValue } from '@package-broker/core/db/port';
import { notificationRuntime } from '@package-broker/core/runtime/notification-jobs';
import { createNotificationPrepareRepository } from '../repositories/notification-prepare.js';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { ulid } from '@package-broker/core/ids';
import { notificationCaptureStatements } from '../repositories/notification-capture.js';
import { createNotificationDispatchRepository } from '../repositories/notification-dispatch.js';
import { createNotificationAttemptRepository } from '../repositories/notification-attempt.js';
import { createNotificationRetentionRepository } from '../repositories/notification-retention.js';
import type { OpenedNotificationOrgs } from './notification-read-contract.js';
import {
  NOW,
  PROJECT_A,
  capturePlan,
  publishedEvent,
  rows,
  run,
  seedEndpoint,
  seedNotificationWorld,
} from './notification-fixture.js';

const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const SWEEP = { id: 'sweep-job', owner: 'sweeper', fence: 1 };
type Row = Record<string, SqlValue>;

async function lease(
  executor: SqlExecutor,
  ctx: OrgContext,
  id: string,
  fence = 1,
  owner = 'owner',
) {
  await run(
    executor,
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES (?, ?, 'core:notification-retention:v1', ?, 'running', ?, '2099-01-01T00:00:00.000Z', ?)
     ON CONFLICT (id) DO UPDATE SET state = 'running', lease_owner = excluded.lease_owner,
       lease_until = '2099-01-01T00:00:00.000Z', fence = excluded.fence`,
    id,
    ctx.orgId,
    `lease:${id}`,
    owner,
    fence,
  );
  return { id, owner, fence };
}

/** Captures, dispatches and returns the deliveries; their jobs stay queued. */
async function scheduled(executor: SqlExecutor, ctx: OrgContext, versions = ['1.0.0']) {
  const plan = capturePlan(
    ctx,
    versions.map((version) => publishedEvent({ version })),
  );
  await executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
  const dispatcher = await lease(executor, ctx, 'dispatch-job');
  const repo = createNotificationDispatchRepository(executor);
  while (!(await repo.dispatchPage(ctx, dispatcher, plan.operationId)).done);
  return {
    plan,
    deliveries: await rows<Row>(
      executor,
      'SELECT * FROM notification_delivery WHERE org_id = ? ORDER BY created_at, id',
      ctx.orgId,
    ),
  };
}

function audit(
  action:
    | 'notification.delivery_started'
    | 'notification.delivery_finished'
    | 'notification.delivery_cancelled',
  delivery: Row,
  extra: Record<string, SqlValue>,
): AuditEvent {
  const fields = {
    endpoint_id: delivery.endpoint_id,
    event_id: delivery.event_id,
    delivery_id: delivery.id,
    ...extra,
  };
  const result = auditEvent({
    id: ulid(),
    now: NOW,
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

const finished = (delivery: Row, reason: string, state: string) =>
  audit('notification.delivery_finished', delivery, {
    ...(Number(delivery.attempts) > 0 ? { attempt: Number(delivery.attempts) } : {}),
    outcome: 'failed',
    reason,
    status: null,
    delivery_state: state,
  });

const cancelled = (delivery: Row, reason: string) =>
  audit('notification.delivery_cancelled', delivery, { reason });

async function one(executor: SqlExecutor, query: string, ...params: SqlValue[]) {
  return (await rows<Row>(executor, query, ...params))[0];
}

async function kill(executor: SqlExecutor, jobId: unknown) {
  await run(executor, "UPDATE job SET state = 'dead' WHERE id = ?", String(jobId));
}

const EP = '01J0EEEEEEEEEEEEEEEEEEEEE1';
const PROJECT_F = '01J0PR0JECT0000000000000PF';

/** The other organization: its own project, source and endpoint E1 (endpoint ids are per organization). */
async function seedForeign(executor: SqlExecutor, foreign: OrgContext) {
  await run(
    executor,
    "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'pf', 'pf')",
    PROJECT_F,
    foreign.orgId,
  );
  await run(
    executor,
    "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES ('C-F-E1', ?, ?, 'npm-notification', x'00', zeroblob(12), 1, 'aad')",
    foreign.orgId,
    PROJECT_F,
  );
  await run(
    executor,
    `INSERT INTO notification_endpoint (org_id, project_id, id, name, method, events_json, package_pattern,
       credential_id, state, created_at, updated_at)
     VALUES (?, ?, 'E1', 'E1', 'POST', '["npm.package.published"]', '*', 'C-F-E1', 'deleted', ?, ?)`,
    foreign.orgId,
    PROJECT_F,
    NOW,
    NOW,
  );
}

/** One delivered delivery (with its attempt) of the other organization, finished at `finishedAt`. */
async function foreignHistory(executor: SqlExecutor, foreign: OrgContext, finishedAt: string) {
  await run(
    executor,
    `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
     VALUES (?, ?, 'F-EV', 'F-OP', 'npm.package.published', 'S-F', 'x', '{}', ?)`,
    foreign.orgId,
    PROJECT_F,
    NOW,
  );
  await run(
    executor,
    `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision,
       configuration_credential_id, state, outcome_code, attempts, next_attempt_at, expires_at, created_at, finished_at)
     VALUES (?, ?, 'F-D', 'F-EV', 'E1', 1, 'C-F-E1', 'delivered', 'ok', 1, ?, ?, ?, ?)`,
    foreign.orgId,
    PROJECT_F,
    NOW,
    NOW,
    NOW,
    finishedAt,
  );
  await run(
    executor,
    `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
     VALUES (?, ?, 'F-D', 1, 'J', 1, 'delivered', 'ok', ?, ?)`,
    foreign.orgId,
    PROJECT_F,
    NOW,
    finishedAt,
  );
}

export function describeNotificationRetentionContract(
  name: string,
  open: () => Promise<OpenedNotificationOrgs>,
): void {
  async function world(
    body: (executor: SqlExecutor, ctx: OrgContext, foreign: OrgContext) => Promise<void>,
  ) {
    const opened = await open();
    try {
      const { a, b } = opened.orgs;
      await seedNotificationWorld(opened.executor, a);
      await seedEndpoint(opened.executor, a, { id: EP });
      await seedForeign(opened.executor, b);
      await lease(opened.executor, a, SWEEP.id, SWEEP.fence, SWEEP.owner);
      await body(opened.executor, a, b);
    } finally {
      await opened.close();
    }
  }

  const repo = createNotificationRetentionRepository;

  describe(`notification repair candidates: ${name}`, () => {
    it('continues 100 expired deliveries over 20 endpoints across invocations below 500 statements', async () => {
      await world(async (executor, ctx) => {
        for (let i = 1; i < 20; i++)
          await seedEndpoint(executor, ctx, {
            id: `01J0EEEEEEEEEEEEEEEEEEE${String(i).padStart(3, '0')}`,
          });
        const plan = capturePlan(
          ctx,
          Array.from({ length: 5 }, (_, i) => publishedEvent({ version: `1.0.${i}` })),
        );
        await executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
        let statements = 0;
        const budgeted: SqlExecutor = {
          driver: executor.driver,
          all(statement) {
            statements++;
            return executor.all(statement);
          },
          batch(batch) {
            statements += batch.length;
            return executor.batch(batch);
          },
        };
        const sweep = notificationRuntime({
          notifications: { enabled: true },
          transport: { allows: () => true, send: async () => ({ kind: 'network', durationMs: 0 }) },
          repositories: () => ({
            retention: repo(budgeted),
            attempts: createNotificationAttemptRepository(budgeted),
            dispatch: createNotificationDispatchRepository(budgeted),
            prepare: createNotificationPrepareRepository(budgeted),
          }),
          credentials: () => {
            throw new Error('retention does not open credentials');
          },
          clock: { now: () => new Date(at(25 * HOUR)) },
          ids: { ulid },
          wake: async () => undefined,
        }).jobs.find((job) => job.qualifiedName === 'core:notification-retention:v1')!.definition;
        const context = {
          org: ctx,
          jobId: SWEEP.id,
          idempotencyKey: 'sweep',
          attempt: 1,
          fence: 1,
          signal: new AbortController().signal,
          ports: {} as never,
          observability: {} as never,
          fences: jobFences(SWEEP),
        };
        await sweep.handler({}, context);
        expect(statements).toBeLessThan(450); // Leaves the runner room to claim and finish the job.
        const remaining = () =>
          one(
            executor,
            "SELECT count(*) AS n FROM notification_delivery WHERE org_id = ? AND state = 'pending'",
            ctx.orgId,
          );
        expect(Number((await remaining())!.n)).toBeGreaterThan(0);
        for (let run = 0; run < 10 && Number((await remaining())!.n) > 0; run++) {
          statements = 0;
          await sweep.handler({}, context);
          expect(statements).toBeLessThan(450);
        }
        expect((await remaining())!.n).toBe(0);
      });
    });

    it('lists nothing while every delivery is in date, accepted and owned by a live job', async () => {
      await world(async (executor, ctx) => {
        await scheduled(executor, ctx);
        expect(await repo(executor).repairCandidates(ctx, at(HOUR), 100)).toEqual([]);
      });
    });

    it('leaves a delivery that dispatch has not scheduled yet to dispatch', async () => {
      await world(async (executor, ctx) => {
        const plan = capturePlan(ctx, [publishedEvent()]);
        await executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
        expect(await repo(executor).repairCandidates(ctx, at(HOUR), 100)).toEqual([]);
      });
    });

    it('expires at the 24-hour deadline, not a millisecond earlier', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx);
        expect(await repo(executor).repairCandidates(ctx, at(24 * HOUR - 1), 100)).toEqual([]);
        const [candidate] = await repo(executor).repairCandidates(ctx, at(24 * HOUR), 100);
        expect(candidate).toMatchObject({ kind: 'expire', delivery: { id: deliveries[0]!.id } });
      });
    });

    it('expires a delivery that used all eight attempts before its deadline', async () => {
      await world(async (executor, ctx) => {
        await scheduled(executor, ctx);
        await run(
          executor,
          'UPDATE notification_delivery SET attempts = 8 WHERE org_id = ?',
          ctx.orgId,
        );
        expect(await repo(executor).repairCandidates(ctx, at(HOUR), 100)).toMatchObject([
          { kind: 'expire' },
        ]);
      });
    });

    it('names why a pending delivery is obsolete', async () => {
      const cases: [string, string, ...SqlValue[]][] = [
        [
          "UPDATE notification_endpoint SET state = 'disabled', disabled_reason = 'manual' WHERE org_id = ?",
          'disabled',
        ],
        [
          "UPDATE notification_endpoint SET state = 'deleted', disabled_reason = NULL WHERE org_id = ?",
          'deleted',
        ],
        ['UPDATE notification_endpoint SET revision = 2 WHERE org_id = ?', 'superseded'],
        ["UPDATE project SET status = 'archived' WHERE org_id = ?", 'project_inactive'],
        ['DELETE FROM project_source WHERE org_id = ?', 'admission_lost'],
        ["UPDATE source SET status = 'paused' WHERE org_id = ?", 'admission_lost'],
      ];
      for (const [change, code] of cases)
        await world(async (executor, ctx) => {
          await scheduled(executor, ctx);
          await run(executor, change, ctx.orgId);
          expect(await repo(executor).repairCandidates(ctx, at(HOUR), 100)).toMatchObject([
            { kind: 'obsolete', code },
          ]);
        });
    });

    it('finds pending deliveries whose job died or vanished and sending ones left behind', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx, ['1.0.0', '1.0.1', '1.0.2']);
        const [dead, gone, orphan] = deliveries;
        await kill(executor, dead!.active_job_id);
        await run(executor, 'DELETE FROM job WHERE id = ?', String(gone!.active_job_id));
        await run(
          executor,
          "UPDATE notification_delivery SET state = 'sending', active_fence = 1 WHERE id = ?",
          String(orphan!.id),
        );
        await kill(executor, orphan!.active_job_id);
        const found = await repo(executor).repairCandidates(ctx, at(HOUR), 100);
        expect(found.map((c) => `${c.delivery.id}:${c.kind}`).sort()).toEqual(
          [
            `${String(dead!.id)}:dead_job`,
            `${String(gone!.id)}:dead_job`,
            `${String(orphan!.id)}:orphan`,
          ].sort(),
        );
        await run(
          executor,
          "UPDATE job SET state = 'queued' WHERE id = ?",
          String(orphan!.active_job_id),
        );
        expect(
          (await repo(executor).repairCandidates(ctx, at(HOUR), 100)).map((c) => c.kind).sort(),
        ).toEqual(['dead_job', 'dead_job']);
      });
    });

    it('pages candidates and refuses a page above 100', async () => {
      await world(async (executor, ctx) => {
        await scheduled(executor, ctx, ['1.0.0', '1.0.1', '1.0.2']);
        expect(await repo(executor).repairCandidates(ctx, at(25 * HOUR), 2)).toHaveLength(2);
        await expect(
          repo(executor).repairCandidates(ctx, at(25 * HOUR), 101),
        ).rejects.toMatchObject({
          code: 'invalid_request',
        });
      });
    });
  });

  describe(`notification repair writes: ${name}`, () => {
    it('expires a due delivery, counts it toward the streak and audits it', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx);
        const delivery = deliveries[0]!;
        const input = {
          deliveryId: String(delivery.id),
          expectedRevision: Number(delivery.revision),
          now: at(24 * HOUR),
          code: 'expired' as const,
          event: finished(delivery, 'expired', 'failed'),
        };
        expect(await repo(executor).expire(ctx, SWEEP, { ...input, now: at(24 * HOUR - 1) })).toBe(
          false,
        );
        expect(await repo(executor).expire(ctx, SWEEP, { ...input, code: 'attempt_limit' })).toBe(
          false,
        );
        expect(await repo(executor).expire(ctx, SWEEP, input)).toBe(true);
        expect(await repo(executor).expire(ctx, SWEEP, input)).toBe(false);
        expect(
          await one(
            executor,
            `SELECT d.state, d.outcome_code, d.finished_at, e.failure_streak,
               (SELECT count(*) FROM audit_pending WHERE org_id = d.org_id AND action = 'notification.delivery_finished') AS audits
             FROM notification_delivery d JOIN notification_endpoint e ON e.org_id = d.org_id AND e.id = d.endpoint_id
             WHERE d.org_id = ?`,
            ctx.orgId,
          ),
        ).toEqual({
          state: 'failed',
          outcome_code: 'expired',
          finished_at: at(24 * HOUR),
          failure_streak: 1,
          audits: 1,
        });
      });
    });

    it('disables the endpoint when an expiry is its tenth terminal failure', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx, ['1.0.0', '1.0.1']);
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 9 WHERE org_id = ?',
          ctx.orgId,
        );
        const delivery = deliveries[0]!;
        expect(
          await repo(executor).expire(ctx, SWEEP, {
            deliveryId: String(delivery.id),
            expectedRevision: Number(delivery.revision),
            now: at(24 * HOUR),
            code: 'expired',
            event: finished(delivery, 'expired', 'failed'),
          }),
        ).toBe(true);
        expect(
          await rows(
            executor,
            'SELECT state, disabled_reason FROM notification_endpoint WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ state: 'disabled', disabled_reason: 'failures' }]);
        expect(
          await one(
            executor,
            'SELECT state, outcome_code FROM notification_delivery WHERE id = ?',
            String(deliveries[1]!.id),
          ),
        ).toEqual({ state: 'cancelled', outcome_code: 'disabled' });
      });
    });

    it('refuses every write under a stale sweep lease', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx);
        const delivery = deliveries[0]!;
        const stale = { ...SWEEP, fence: 2 };
        const base = {
          deliveryId: String(delivery.id),
          expectedRevision: Number(delivery.revision),
          now: at(24 * HOUR),
        };
        await kill(executor, delivery.active_job_id);
        expect(
          await repo(executor).expire(ctx, stale, {
            ...base,
            code: 'expired',
            event: finished(delivery, 'expired', 'failed'),
          }),
        ).toBe(false);
        expect(
          await repo(executor).cancel(ctx, stale, {
            ...base,
            code: 'disabled',
            event: cancelled(delivery, 'disabled'),
          }),
        ).toBe(false);
        expect(await repo(executor).requeue(ctx, stale, { ...base, jobId: ulid() })).toBeNull();
        await expect(
          repo(executor).prune(ctx, stale, {
            now: at(30 * 24 * HOUR),
            before: at(29 * 24 * HOUR),
            limit: 100,
          }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        expect(
          await one(
            executor,
            'SELECT state, revision FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual({
          state: 'pending',
          revision: delivery.revision,
        });
      });
    });

    it('turns an orphaned started attempt into unknown without counting it', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx);
        const delivery = deliveries[0]!;
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        const attempts = createNotificationAttemptRepository(executor);
        const reserved = await attempts.reserve(ctx, job, {
          deliveryId: String(delivery.id),
          expectedRevision: 1,
          now: NOW,
          event: audit('notification.delivery_started', delivery, { attempt: 1 }),
        });
        expect(reserved).toEqual({ ok: true, attempt: 1, revision: 2 });
        const input = {
          deliveryId: String(delivery.id),
          expectedRevision: 2,
          now: at(HOUR),
          delivery: { state: 'pending' as const, nextAttemptAt: at(HOUR + 5 * 60_000) },
          event: audit('notification.delivery_finished', delivery, {
            attempt: 1,
            outcome: 'unknown',
            reason: 'unknown',
            status: null,
            delivery_state: 'pending',
          }),
        };
        expect(await repo(executor).reconcileOrphan(ctx, SWEEP, input)).toBe(false);
        await kill(executor, delivery.active_job_id);
        expect(await repo(executor).reconcileOrphan(ctx, SWEEP, input)).toBe(true);
        expect(
          await one(
            executor,
            `SELECT d.state, d.attempts, d.next_attempt_at, d.expires_at, a.outcome, e.failure_streak
             FROM notification_delivery d
             JOIN notification_attempt a ON a.org_id = d.org_id AND a.delivery_id = d.id
             JOIN notification_endpoint e ON e.org_id = d.org_id AND e.id = d.endpoint_id WHERE d.org_id = ?`,
            ctx.orgId,
          ),
        ).toEqual({
          state: 'pending',
          attempts: 1,
          next_attempt_at: at(HOUR + 5 * 60_000),
          expires_at: delivery.expires_at,
          outcome: 'unknown',
          failure_streak: 0,
        });
      });
    });

    it('cancels an obsolete pending delivery with its reason and audit', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx);
        const delivery = deliveries[0]!;
        const input = {
          deliveryId: String(delivery.id),
          expectedRevision: Number(delivery.revision),
          now: at(HOUR),
          code: 'superseded' as const,
          event: cancelled(delivery, 'superseded'),
        };
        expect(await repo(executor).cancel(ctx, SWEEP, { ...input, expectedRevision: 9 })).toBe(
          false,
        );
        expect(await repo(executor).cancel(ctx, SWEEP, input)).toBe(true);
        expect(
          await one(
            executor,
            `SELECT state, outcome_code, finished_at,
               (SELECT count(*) FROM audit_pending WHERE org_id = ? AND action = 'notification.delivery_cancelled') AS audits,
               (SELECT failure_streak FROM notification_endpoint WHERE org_id = ?) AS streak
             FROM notification_delivery WHERE org_id = ?`,
            ctx.orgId,
            ctx.orgId,
            ctx.orgId,
          ),
        ).toEqual({
          state: 'cancelled',
          outcome_code: 'superseded',
          finished_at: at(HOUR),
          audits: 1,
          streak: 0,
        });
      });
    });

    it('replaces a dead delivery job with the next generation, keeping attempts and deadline', async () => {
      await world(async (executor, ctx) => {
        const { deliveries } = await scheduled(executor, ctx);
        const delivery = deliveries[0]!;
        const input = {
          deliveryId: String(delivery.id),
          expectedRevision: Number(delivery.revision),
          jobId: ulid(),
        };
        expect(await repo(executor).requeue(ctx, SWEEP, input)).toBeNull();
        await kill(executor, delivery.active_job_id);
        expect(await repo(executor).requeue(ctx, SWEEP, input)).toBe(input.jobId);
        expect(await repo(executor).requeue(ctx, SWEEP, { ...input, jobId: ulid() })).toBeNull();
        expect(
          await one(
            executor,
            `SELECT d.job_generation, d.attempts, d.expires_at, d.active_job_id, j.payload_json, j.idempotency_key, j.resource_key, j.state
             FROM notification_delivery d JOIN job j ON j.id = d.active_job_id WHERE d.org_id = ?`,
            ctx.orgId,
          ),
        ).toEqual({
          job_generation: 2,
          attempts: 0,
          expires_at: delivery.expires_at,
          active_job_id: input.jobId,
          payload_json: `{"deliveryId":"${String(delivery.id)}"}`,
          idempotency_key: `core:notification-deliver:v1:deliver:${String(delivery.id)}:2`,
          resource_key: `notification:${String(delivery.endpoint_id)}`,
          state: 'queued',
        });
      });
    });

    it('restarts a stalled dispatch with the next generation and leaves a live one alone', async () => {
      await world(async (executor, ctx) => {
        const plan = capturePlan(ctx, [publishedEvent()]);
        await executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
        const ids = [ulid(), ulid()];
        const jobId = () => ids.shift()!;
        expect(
          await repo(executor).redispatch(ctx, SWEEP, { now: at(HOUR), limit: 100, jobId }),
        ).toEqual([]);
        await run(
          executor,
          "UPDATE job SET state = 'dead' WHERE org_id = ? AND type = 'core:notification-dispatch:v1'",
          ctx.orgId,
        );
        const [restarted] = await repo(executor).redispatch(ctx, SWEEP, {
          now: at(HOUR),
          limit: 100,
          jobId,
        });
        expect(
          await one(
            executor,
            `SELECT e.dispatch_generation, j.idempotency_key, j.payload_json, j.state
             FROM notification_event e JOIN job j ON j.id = ? WHERE e.org_id = ?`,
            String(restarted),
            ctx.orgId,
          ),
        ).toEqual({
          dispatch_generation: 2,
          idempotency_key: `core:notification-dispatch:v1:dispatch:${plan.operationId}:2`,
          payload_json: `{"operationId":"${plan.operationId}"}`,
          state: 'queued',
        });
        expect(
          await repo(executor).redispatch(ctx, SWEEP, { now: at(HOUR), limit: 100, jobId }),
        ).toEqual([]);
      });
    });
  });

  describe(`notification retention prune: ${name}`, () => {
    /** Finishes the deliveries at the given instants; their attempts finish then too. */
    async function terminal(executor: SqlExecutor, ctx: OrgContext, finishedAt: readonly string[]) {
      const { deliveries } = await scheduled(
        executor,
        ctx,
        finishedAt.map((_, i) => `2.0.${i}`),
      );
      const queue = [...deliveries];
      for (const when of finishedAt) {
        const delivery = queue.shift()!;
        await run(
          executor,
          `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
           VALUES (?, ?, ?, 1, 'J', 1, 'delivered', 'ok', ?, ?)`,
          ctx.orgId,
          PROJECT_A,
          String(delivery.id),
          NOW,
          when,
        );
        await run(
          executor,
          "UPDATE notification_delivery SET state = 'delivered', outcome_code = 'ok', attempts = 1, finished_at = ? WHERE id = ?",
          when,
          String(delivery.id),
        );
      }
      return deliveries;
    }

    const BEFORE = at(7 * 24 * HOUR);
    const PRUNE = { now: at(8 * 24 * HOUR), before: BEFORE, limit: 100 };

    it('prunes history finished before the seven-day boundary, attempts first, never pending work', async () => {
      await world(async (executor, ctx, foreign) => {
        const [old, edge] = await terminal(executor, ctx, [at(7 * 24 * HOUR - 1), BEFORE]);
        await foreignHistory(executor, foreign, at(HOUR));
        await scheduled(executor, ctx, ['3.0.0']);
        const audits = await rows(executor, 'SELECT count(*) AS n FROM audit_pending');
        expect(await repo(executor).prune(ctx, SWEEP, PRUNE)).toEqual({
          attempts: 1,
          deliveries: 1,
          events: 1,
          endpoints: 0,
          credentials: 0,
        });
        expect(
          (
            await rows<Row>(
              executor,
              'SELECT id, state FROM notification_delivery WHERE org_id = ? ORDER BY state',
              ctx.orgId,
            )
          ).map((row) => row.state),
        ).toEqual(['delivered', 'pending']);
        expect(
          await one(
            executor,
            'SELECT id FROM notification_delivery WHERE org_id = ? AND state = ?',
            ctx.orgId,
            'delivered',
          ),
        ).toEqual({
          id: edge!.id,
        });
        expect(
          await rows(
            executor,
            'SELECT 1 FROM notification_attempt WHERE delivery_id = ?',
            String(old!.id),
          ),
        ).toEqual([]);
        expect(
          await rows(
            executor,
            'SELECT 1 FROM notification_event WHERE id = ?',
            String(old!.event_id),
          ),
        ).toEqual([]);
        expect(
          await one(
            executor,
            'SELECT count(*) AS n FROM notification_delivery WHERE org_id = ?',
            foreign.orgId,
          ),
        ).toEqual({ n: 1 });
        expect(await rows(executor, 'SELECT count(*) AS n FROM audit_pending')).toEqual(audits);
      });
    });

    it('prunes at most one page per call, oldest first', async () => {
      await world(async (executor, ctx) => {
        await terminal(executor, ctx, [at(3 * HOUR), at(HOUR), at(2 * HOUR)]);
        expect(await repo(executor).prune(ctx, SWEEP, { ...PRUNE, limit: 2 })).toMatchObject({
          deliveries: 2,
        });
        expect(
          await rows(
            executor,
            'SELECT finished_at FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ finished_at: at(3 * HOUR) }]);
      });
    });

    it('removes a deleted endpoint only after its last delivery, then its unreferenced credentials', async () => {
      await world(async (executor, ctx, foreign) => {
        await seedEndpoint(executor, ctx, { id: 'E-gone', state: 'deleted' });
        await seedEndpoint(executor, ctx, { id: 'E-live', state: 'disabled' });
        const [kept] = await terminal(executor, ctx, [at(8 * 24 * HOUR - 1)]);
        await run(
          executor,
          "UPDATE notification_endpoint SET state = 'deleted', disabled_reason = NULL, updated_at = ? WHERE org_id = ? AND id = ?",
          NOW,
          ctx.orgId,
          EP,
        );
        const insert = (id: string, kind: string, created = NOW) =>
          run(
            executor,
            "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad, created_at) VALUES (?, ?, ?, ?, x'00', zeroblob(12), 1, 'aad', ?)",
            id,
            ctx.orgId,
            PROJECT_A,
            kind,
            created,
          );
        await insert('C-body', 'npm-notification-body');
        await insert('C-old-config', 'npm-notification');
        await insert('C-fresh', 'npm-notification', at(7 * 24 * HOUR));
        await insert('C-source', 'source-token');
        await insert('C-replaced', 'npm-notification');
        await run(
          executor,
          "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad, created_at) VALUES ('C-foreign', ?, ?, 'npm-notification', x'00', zeroblob(12), 1, 'aad', ?)",
          foreign.orgId,
          PROJECT_F,
          NOW,
        );
        await run(
          executor,
          "UPDATE notification_delivery SET body_credential_id = 'C-body', configuration_credential_id = 'C-replaced' WHERE id = ?",
          String(kept!.id),
        );
        expect(await repo(executor).prune(ctx, SWEEP, PRUNE)).toMatchObject({
          endpoints: 1,
          credentials: 2,
        });
        expect(
          await rows(
            executor,
            'SELECT id FROM notification_endpoint WHERE org_id = ? ORDER BY id',
            ctx.orgId,
          ),
        ).toEqual([{ id: EP }, { id: 'E-live' }]);
        expect(await rows(executor, 'SELECT id FROM credential ORDER BY id')).toEqual(
          expect.arrayContaining([
            { id: 'C-E-live' },
            { id: `C-${EP}` },
            { id: 'C-body' },
            { id: 'C-fresh' },
            { id: 'C-source' },
            { id: 'C-foreign' },
            { id: 'C-replaced' },
          ]),
        );
        expect(
          await rows(
            executor,
            "SELECT id FROM credential WHERE id IN ('C-E-gone', 'C-old-config')",
          ),
        ).toEqual([]);
        expect(
          await repo(executor).prune(ctx, SWEEP, {
            ...PRUNE,
            now: at(9 * 24 * HOUR),
            before: at(8 * 24 * HOUR),
          }),
        ).toMatchObject({
          deliveries: 1,
          endpoints: 1,
          credentials: 4,
        });
        expect(await rows(executor, 'SELECT id FROM credential ORDER BY id')).toEqual([
          { id: 'C-E-live' },
          { id: 'C-F-E1' },
          { id: 'C-foreign' },
          { id: 'C-source' },
        ]);
      });
    });

    it('refuses a boundary later than now and a page above 100', async () => {
      await world(async (executor, ctx) => {
        await expect(
          repo(executor).prune(ctx, SWEEP, { now: NOW, before: at(1), limit: 1 }),
        ).rejects.toMatchObject({
          code: 'invalid_request',
        });
        await expect(
          repo(executor).prune(ctx, SWEEP, { ...PRUNE, limit: 101 }),
        ).rejects.toMatchObject({
          code: 'invalid_request',
        });
      });
    });
  });
}
