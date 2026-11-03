import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { notificationCaptureStatements } from '../repositories/notification-capture.js';
import { createNotificationDispatchRepository } from '../repositories/notification-dispatch.js';
import { createNotificationPrepareRepository } from '../repositories/notification-prepare.js';
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
const ENDPOINT = '01J0EEEEEEEEEEEEEEEEEEEEE0';
type Row = Record<string, unknown>;

async function lease(executor: SqlExecutor, ctx: OrgContext, id: string, fence = 1) {
  await run(
    executor,
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES (?, ?, 'core:notification-deliver:v1', ?, 'running', 'owner', '2099-01-01T00:00:00.000Z', ?)
     ON CONFLICT (id) DO UPDATE SET state = 'running', lease_owner = 'owner',
       lease_until = '2099-01-01T00:00:00.000Z', fence = excluded.fence`,
    id,
    ctx.orgId,
    `lease:${id}`,
    fence,
  );
  return { id, owner: 'owner', fence };
}

function audit(
  action: 'notification.delivery_cancelled' | 'notification.delivery_finished',
  delivery: Row,
  reason: string,
): AuditEvent {
  const fields: Record<string, unknown> = {
    endpoint_id: delivery.endpoint_id,
    event_id: delivery.event_id,
    delivery_id: delivery.id,
    reason,
    ...(action === 'notification.delivery_finished'
      ? { outcome: 'failed', delivery_state: 'failed' }
      : {}),
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

/** A sealed-looking credential row; the repository never decrypts it. */
function credentialStatement(ctx: OrgContext, id: string, projectId = PROJECT_A): Statement {
  return {
    sql: "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, 'npm-notification-body', x'00', zeroblob(12), 1, 'aad')",
    params: [id, ctx.orgId, projectId],
  };
}

export function describeNotificationPrepareContract(
  name: string,
  open: () => Promise<OpenedNotificationOrgs>,
): void {
  async function world(
    body: (executor: SqlExecutor, ctx: OrgContext, delivery: Row) => Promise<void>,
  ) {
    const opened = await open();
    try {
      const ctx = opened.orgs.a;
      await seedNotificationWorld(opened.executor, ctx);
      await seedEndpoint(opened.executor, ctx, { id: ENDPOINT });
      const plan = capturePlan(ctx, [publishedEvent({ version: '1.0.0' })]);
      await opened.executor.batch(notificationCaptureStatements(ctx, plan, sql<boolean>`1`));
      const dispatcher = await lease(opened.executor, ctx, 'dispatch-job');
      await createNotificationDispatchRepository(opened.executor).dispatchPage(
        ctx,
        dispatcher,
        plan.operationId,
      );
      const [delivery] = await rows<Row>(
        opened.executor,
        'SELECT * FROM notification_delivery WHERE org_id = ?',
        ctx.orgId,
      );
      await body(opened.executor, ctx, delivery!);
    } finally {
      await opened.close();
    }
  }

  const prepare = createNotificationPrepareRepository;

  describe(`notification delivery preparation: ${name}`, () => {
    it('reads the delivery with its event, endpoint, project and admission facts', async () => {
      await world(async (executor, ctx, delivery) => {
        const context = await prepare(executor).context(ctx, String(delivery.id));
        expect(context).toMatchObject({
          delivery: {
            id: delivery.id,
            state: 'pending',
            endpointRevision: 1,
            bodyCredentialId: null,
          },
          endpoint: { state: 'enabled', revision: 1, method: 'POST' },
          projectActive: true,
          admitted: true,
        });
        expect(JSON.parse(context!.payloadJson)).toMatchObject({ type: 'npm.package.published' });
      });
    });

    it('reports detachment, archive, a changed and a removed endpoint', async () => {
      await world(async (executor, ctx, delivery) => {
        const read = () => prepare(executor).context(ctx, String(delivery.id));
        await run(
          executor,
          'DELETE FROM project_source WHERE org_id = ? AND project_id = ? AND source_id = ?',
          ctx.orgId,
          PROJECT_A,
          SOURCE,
        );
        expect((await read())?.admitted).toBe(false);
        await run(
          executor,
          "UPDATE project SET status = 'archived' WHERE org_id = ? AND id = ?",
          ctx.orgId,
          PROJECT_A,
        );
        expect((await read())?.projectActive).toBe(false);
        await run(
          executor,
          "UPDATE notification_endpoint SET revision = 3, state = 'disabled', disabled_reason = 'manual' WHERE org_id = ?",
          ctx.orgId,
        );
        expect((await read())?.endpoint).toEqual({
          state: 'disabled',
          revision: 3,
          method: 'POST',
        });
        expect(
          await prepare(executor).context(ctx, '00000000-0000-4000-8000-000000000000'),
        ).toBeNull();
      });
    });

    it('does not count a source attached only to another project as admission', async () => {
      await world(async (executor, ctx, delivery) => {
        await run(
          executor,
          'DELETE FROM project_source WHERE org_id = ? AND project_id = ?',
          ctx.orgId,
          PROJECT_A,
        );
        const context = await prepare(executor).context(ctx, String(delivery.id));
        expect(context?.admitted).toBe(false);
        expect(
          await rows(
            executor,
            'SELECT count(*) AS n FROM project_source WHERE org_id = ? AND project_id = ?',
            ctx.orgId,
            PROJECT_B,
          ),
        ).toEqual([{ n: 1 }]);
      });
    });

    it('seals the body once under the claim and refuses a second, stale or foreign attach', async () => {
      await world(async (executor, ctx, delivery) => {
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        const id = String(delivery.id);
        const first = ulid();
        expect(
          await prepare(executor).attachBody(ctx, job, {
            deliveryId: id,
            expectedRevision: 1,
            credentialId: first,
            statement: credentialStatement(ctx, first),
          }),
        ).toBe(true);
        const second = ulid();
        expect(
          await prepare(executor).attachBody(ctx, job, {
            deliveryId: id,
            expectedRevision: 1,
            credentialId: second,
            statement: credentialStatement(ctx, second),
          }),
        ).toBe(false);
        expect(
          await rows(
            executor,
            'SELECT body_credential_id FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ body_credential_id: first }]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM credential WHERE org_id = ? AND kind = 'npm-notification-body'",
            ctx.orgId,
          ),
        ).toEqual([{ n: 1 }]);
      });
    });

    it('refuses a body attach by a job that does not hold the delivery, or at a stale revision', async () => {
      await world(async (executor, ctx, delivery) => {
        const id = String(delivery.id);
        const other = await lease(executor, ctx, 'other-job');
        const own = await lease(executor, ctx, String(delivery.active_job_id));
        for (const [job, revision] of [
          [other, 1],
          [own, 2],
          [{ ...own, fence: 9 }, 1],
        ] as const) {
          const credentialId = ulid();
          expect(
            await prepare(executor).attachBody(ctx, job, {
              deliveryId: id,
              expectedRevision: revision,
              credentialId,
              statement: credentialStatement(ctx, credentialId),
            }),
          ).toBe(false);
        }
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM credential WHERE org_id = ? AND kind = 'npm-notification-body'",
            ctx.orgId,
          ),
        ).toEqual([{ n: 0 }]);
      });
    });

    it('refuses a body credential of another project', async () => {
      await world(async (executor, ctx, delivery) => {
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        const credentialId = ulid();
        await expect(
          prepare(executor).attachBody(ctx, job, {
            deliveryId: String(delivery.id),
            expectedRevision: 1,
            credentialId,
            statement: credentialStatement(ctx, credentialId, PROJECT_B),
          }),
        ).rejects.toThrow();
        expect(
          await rows(
            executor,
            'SELECT body_credential_id FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ body_credential_id: null }]);
      });
    });

    it('cancels with the fixed reason and audit, never touching the failure streak', async () => {
      await world(async (executor, ctx, delivery) => {
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        const input = {
          deliveryId: String(delivery.id),
          expectedRevision: 1,
          now: LATER,
          code: 'admission_lost' as const,
          event: audit('notification.delivery_cancelled', delivery, 'admission_lost'),
        };
        await expect(
          prepare(executor).cancel(ctx, job, { ...input, code: 'superseded' }),
        ).rejects.toMatchObject({ code: 'invalid_request' });
        expect(await prepare(executor).cancel(ctx, job, { ...input, expectedRevision: 2 })).toBe(
          false,
        );
        expect(await prepare(executor).cancel(ctx, job, input)).toBe(true);
        expect(
          await rows(
            executor,
            'SELECT state, outcome_code, finished_at, revision FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([
          { state: 'cancelled', outcome_code: 'admission_lost', finished_at: LATER, revision: 2 },
        ]);
        expect(
          await rows(
            executor,
            'SELECT failure_streak, state FROM notification_endpoint WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ failure_streak: 0, state: 'enabled' }]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM audit_pending WHERE org_id = ? AND action = 'notification.delivery_cancelled'",
            ctx.orgId,
          ),
        ).toEqual([{ n: 1 }]);
        expect(await prepare(executor).cancel(ctx, job, input)).toBe(false);
      });
    });

    it('fails without an attempt, counts the streak and disables at once for a credential failure', async () => {
      await world(async (executor, ctx, delivery) => {
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        expect(
          await prepare(executor).finish(ctx, job, {
            deliveryId: String(delivery.id),
            expectedRevision: 1,
            now: LATER,
            code: 'credentials',
            disable: 'credentials',
            event: audit('notification.delivery_finished', delivery, 'credentials'),
          }),
        ).toBe(true);
        expect(
          await rows(
            executor,
            'SELECT state, outcome_code, attempts FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ state: 'failed', outcome_code: 'credentials', attempts: 0 }]);
        expect(
          await rows(
            executor,
            'SELECT state, disabled_reason, failure_streak, revision FROM notification_endpoint WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([
          { state: 'disabled', disabled_reason: 'credentials', failure_streak: 1, revision: 2 },
        ]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM audit_pending WHERE org_id = ? AND action IN ('notification.delivery_finished', 'notification.auto_disable')",
            ctx.orgId,
          ),
        ).toEqual([{ n: 2 }]);
      });
    });

    it('keeps a template defect out of the endpoint failure streak and preserves its backlog', async () => {
      await world(async (executor, ctx, delivery) => {
        await run(
          executor,
          'UPDATE notification_endpoint SET failure_streak = 9 WHERE org_id = ?',
          ctx.orgId,
        );
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        expect(
          await prepare(executor).finish(ctx, job, {
            deliveryId: String(delivery.id),
            expectedRevision: 1,
            now: LATER,
            code: 'template',
            disable: null,
            event: audit('notification.delivery_finished', delivery, 'template'),
          }),
        ).toBe(true);
        expect(
          await rows(
            executor,
            'SELECT state, failure_streak FROM notification_endpoint WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ state: 'enabled', failure_streak: 9 }]);
        expect(
          await rows(
            executor,
            'SELECT state, outcome_code FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ state: 'failed', outcome_code: 'template' }]);
      });
    });

    it('counts an expiry toward the streak without disabling below the limit', async () => {
      await world(async (executor, ctx, delivery) => {
        const job = await lease(executor, ctx, String(delivery.active_job_id));
        const input = {
          deliveryId: String(delivery.id),
          expectedRevision: 1,
          now: LATER,
          code: 'expired' as const,
          disable: null,
          event: audit('notification.delivery_finished', delivery, 'expired'),
        };
        await expect(
          prepare(executor).finish(ctx, job, { ...input, code: 'template' }),
        ).rejects.toMatchObject({ code: 'invalid_request' });
        expect(
          await prepare(executor).finish(ctx, await lease(executor, ctx, 'other'), input),
        ).toBe(false);
        expect(await prepare(executor).finish(ctx, job, input)).toBe(true);
        expect(
          await rows(
            executor,
            'SELECT state, failure_streak FROM notification_endpoint WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ state: 'enabled', failure_streak: 1 }]);
      });
    });
  });
}
