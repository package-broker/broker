import { expect } from 'vitest';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createNotificationDispatchRepository } from '../../repositories/notification-dispatch.js';
import { createNotificationRetentionRepository } from '../../repositories/notification-retention.js';
import { NOW, PROJECT_A, rows, run } from '../../contract/notification-fixture.js';
import { captured, leaseJob } from './notification-dispatch.js';
import { executing } from './factory-cases.js';
import { seeder, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

type Row = Record<string, SqlValue>;
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const SWEEP = { id: 'sweep-job', owner: 'owner', fence: 1 };

/**
 * The acting organization is the second fixture organization, so a twin row of the first one
 * sorts ahead of it in every (org_id, …) index and a dropped comparison reaches the twin.
 */
async function armed(context: CaseContext, operations = 1) {
  const { own: actor, foreign: other, plans } = await captured(context, 1, operations, true);
  for (const plan of plans)
    await createNotificationDispatchRepository(context.executor).dispatchPage(
      actor,
      { id: 'dispatch-job', owner: 'owner', fence: 1 },
      plan.operationId,
    );
  await leaseJob(context.executor, actor, SWEEP.id);
  const deliveries = await rows<Row>(
    context.executor,
    'SELECT * FROM notification_delivery WHERE org_id = ? ORDER BY id',
    actor.orgId,
  );
  return { actor, other, plans, delivery: deliveries[0]!, deliveries };
}

let twins = 0;

type Table =
  | 'notification_delivery'
  | 'notification_endpoint'
  | 'notification_attempt'
  | 'notification_event'
  | 'project_source'
  | 'credential'
  | 'job';

/** Copies the acting organization's rows into the other organization, ahead of them in rowid order. */
async function twin(
  context: CaseContext,
  table: Table,
  from: OrgContext,
  to: OrgContext,
  overrides: Row | ((row: Row) => Row) = {},
  where = '1',
) {
  const found = await rows<Row>(
    context.executor,
    `SELECT * FROM ${table} WHERE org_id = ? AND ${where}`,
    from.orgId,
  );
  for (const row of found) {
    twins -= 1;
    const copy: Row = {
      ...(table === 'project_source' ? {} : { rowid: twins }),
      ...row,
      org_id: to.orgId,
      ...(typeof overrides === 'function' ? overrides(row) : overrides),
    };
    const columns = Object.keys(copy);
    await seeder(context.executor).forged(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...(Object.values(copy) as (string | number | null)[]),
    );
  }
}

function audit(
  action: 'notification.delivery_finished' | 'notification.delivery_cancelled',
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

const repo = (context: CaseContext) => createNotificationRetentionRepository(executing(context));
const attempt = <T>(promise: Promise<T>) => promise.catch(() => 'error' as const);
const one = async (context: CaseContext, query: string, ...params: SqlValue[]) =>
  (await rows<Row>(context.executor, query, ...params))[0];
const kinds = async (context: CaseContext, actor: OrgContext, now = at(HOUR)) => {
  const found = await attempt(repo(context).repairCandidates(actor, now, 100));
  return found === 'error'
    ? found
    : found.map((c) => [c.kind, 'code' in c ? c.code : null, c.delivery.lastFinishedAt]);
};

const candidatesDeliveryTwin: ContractCase = {
  name: 'repair lists no foreign delivery next to a healthy own one',
  async run(context) {
    const { actor, other } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, { expires_at: NOW });
    expect(await kinds(context, actor)).toEqual([]);
  },
};

const candidatesJoinTwin: ContractCase = {
  name: 'repair joins the own event and attempts of an expired own delivery only',
  async run(context) {
    const { actor, other } = await armed(context);
    await twin(context, 'notification_event', actor, other);
    await twin(context, 'notification_delivery', actor, other, {
      state: 'failed',
      finished_at: NOW,
    });
    await run(
      context.executor,
      `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
       SELECT org_id, project_id, id, 1, 'J', 1, 'failed', 'network', ?, ? FROM notification_delivery WHERE org_id = ?`,
      NOW,
      NOW,
      other.orgId,
    );
    expect(await kinds(context, actor, at(25 * HOUR))).toEqual([['expire', null, null]]);
  },
};

const candidatesEndpointTwin: ContractCase = {
  name: 'repair reads the own endpoint, not a disabled foreign twin',
  async run(context) {
    const { actor, other } = await armed(context);
    await twin(context, 'notification_endpoint', actor, other, {
      state: 'disabled',
      disabled_reason: 'manual',
    });
    expect(await kinds(context, actor)).toEqual([]);
  },
};

const candidatesSourceTwin: ContractCase = {
  name: 'repair needs the attached source to be the own one',
  async run(context) {
    const { actor, other } = await armed(context);
    await seeder(context.executor).forged(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S-foreign', ?, 'Foreign', 'npm', 'hosted')",
      other.orgId,
    );
    await seeder(context.executor).forged(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'S-foreign')",
      actor.orgId,
      PROJECT_A,
    );
    await run(
      context.executor,
      "UPDATE notification_event SET source_id = 'S-foreign' WHERE org_id = ?",
      actor.orgId,
    );
    expect(await kinds(context, actor)).toEqual([['obsolete', 'admission_lost', null]]);
  },
};

function expireInput(delivery: Row, now: string) {
  return {
    deliveryId: String(delivery.id),
    expectedRevision: Number(delivery.revision),
    now,
    code: 'expired' as const,
    event: audit('notification.delivery_finished', delivery, {
      outcome: 'failed',
      reason: 'expired',
      status: null,
      delivery_state: 'failed',
    }),
  };
}

const expireGuardTwin: ContractCase = {
  name: 'expire refuses an own delivery that is not due, even when a foreign twin is',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, { expires_at: NOW });
    expect(await attempt(repo(context).expire(actor, SWEEP, expireInput(delivery, at(HOUR))))).toBe(
      false,
    );
  },
};

const expireRowsTwin: ContractCase = {
  name: 'expire changes and counts only the own delivery and endpoint',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, { endpoint_revision: 5 });
    await twin(context, 'notification_endpoint', actor, other);
    expect(
      await attempt(repo(context).expire(actor, SWEEP, expireInput(delivery, at(24 * HOUR)))),
    ).toBe(true);
    expect(
      await one(
        context,
        `SELECT d.state, e.failure_streak FROM notification_delivery d
         JOIN notification_endpoint e ON e.org_id = d.org_id AND e.id = d.endpoint_id WHERE d.org_id = ?`,
        other.orgId,
      ),
    ).toEqual({ state: 'pending', failure_streak: 0 });
    expect(
      await one(
        context,
        'SELECT failure_streak FROM notification_endpoint WHERE org_id = ?',
        actor.orgId,
      ),
    ).toEqual({ failure_streak: 1 });
  },
};

function orphanInput(delivery: Row, revision: number) {
  return {
    deliveryId: String(delivery.id),
    expectedRevision: revision,
    now: at(HOUR),
    delivery: { state: 'pending' as const, nextAttemptAt: at(2 * HOUR) },
    event: audit('notification.delivery_finished', delivery, {
      attempt: 1,
      outcome: 'unknown',
      reason: 'unknown',
      status: null,
      delivery_state: 'pending',
    }),
  };
}

async function sending(context: CaseContext, actor: OrgContext, delivery: Row) {
  await run(
    context.executor,
    "UPDATE notification_delivery SET state = 'sending', attempts = 1, active_fence = 1, revision = 2 WHERE org_id = ?",
    actor.orgId,
  );
  await run(
    context.executor,
    `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at)
     VALUES (?, ?, ?, 1, ?, 1, 'started', ?)`,
    actor.orgId,
    String(delivery.project_id),
    String(delivery.id),
    String(delivery.active_job_id),
    NOW,
  );
}

const orphanGuardTwin: ContractCase = {
  name: 'reconcile refuses an own delivery whose job lives, even when a foreign twin is orphaned',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await sending(context, actor, delivery);
    await twin(context, 'notification_delivery', actor, other, { active_job_id: 'gone-job' });
    expect(
      await attempt(repo(context).reconcileOrphan(actor, SWEEP, orphanInput(delivery, 2))),
    ).toBe(false);
  },
};

const orphanRowsTwin: ContractCase = {
  name: 'reconcile resolves only the own orphaned attempt and delivery',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await sending(context, actor, delivery);
    await twin(context, 'notification_delivery', actor, other);
    await twin(context, 'notification_attempt', actor, other);
    await run(
      context.executor,
      "UPDATE job SET state = 'dead' WHERE id = ?",
      String(delivery.active_job_id),
    );
    expect(
      await attempt(repo(context).reconcileOrphan(actor, SWEEP, orphanInput(delivery, 2))),
    ).toBe(true);
    expect(
      await one(
        context,
        `SELECT d.state, a.outcome FROM notification_delivery d
         JOIN notification_attempt a ON a.org_id = d.org_id AND a.delivery_id = d.id WHERE d.org_id = ?`,
        other.orgId,
      ),
    ).toEqual({ state: 'sending', outcome: 'started' });
  },
};

function cancelInput(delivery: Row, revision: number) {
  return {
    deliveryId: String(delivery.id),
    expectedRevision: revision,
    now: at(HOUR),
    code: 'disabled' as const,
    event: audit('notification.delivery_cancelled', delivery, { reason: 'disabled' }),
  };
}

const cancelGuardTwin: ContractCase = {
  name: 'cancel refuses a stale own revision, even when a foreign twin has it',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, { revision: 7 });
    expect(await attempt(repo(context).cancel(actor, SWEEP, cancelInput(delivery, 7)))).toBe(false);
  },
};

const cancelRowsTwin: ContractCase = {
  name: 'cancel changes only the own delivery',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await twin(context, 'notification_delivery', actor, other);
    expect(
      await attempt(
        repo(context).cancel(actor, SWEEP, cancelInput(delivery, Number(delivery.revision))),
      ),
    ).toBe(true);
    expect(
      await one(context, 'SELECT state FROM notification_delivery WHERE org_id = ?', other.orgId),
    ).toEqual({ state: 'pending' });
  },
};

const requeueGuardTwin: ContractCase = {
  name: 'requeue refuses an own delivery whose job lives, even when a foreign twin lost its job',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, { active_job_id: 'gone-job' });
    expect(
      await attempt(
        repo(context).requeue(actor, SWEEP, {
          deliveryId: String(delivery.id),
          expectedRevision: Number(delivery.revision),
          jobId: ulid(),
        }),
      ),
    ).toBeNull();
  },
};

const requeueRowsTwin: ContractCase = {
  name: 'requeue changes and reports only the own delivery and its own new job',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await run(
      context.executor,
      "UPDATE job SET state = 'dead' WHERE id = ?",
      String(delivery.active_job_id),
    );
    await twin(context, 'notification_delivery', actor, other, {
      active_job_id: 'foreign-job',
      job_generation: 5,
    });
    const jobId = ulid();
    await seeder(context.executor).forged(
      `INSERT INTO job (rowid, id, org_id, type, idempotency_key, state) VALUES (-1000, 'foreign-new-job', ?, 'core:notification-deliver:v1', ?, 'queued')`,
      other.orgId,
      `core:notification-deliver:v1:deliver:${String(delivery.id)}:2`,
    );
    expect(
      await attempt(
        repo(context).requeue(actor, SWEEP, {
          deliveryId: String(delivery.id),
          expectedRevision: Number(delivery.revision),
          jobId,
        }),
      ),
    ).toBe(jobId);
    expect(
      await one(
        context,
        'SELECT job_generation, active_job_id FROM notification_delivery WHERE org_id = ?',
        other.orgId,
      ),
    ).toEqual({ job_generation: 5, active_job_id: 'foreign-job' });
  },
};

const redispatchTwin: ContractCase = {
  name: 'redispatch restarts only own stalled operations, judged by own jobs',
  async run(context) {
    const { actor, other, plans } = await armed(context, 2);
    const [live, stalled] = plans;
    await run(
      context.executor,
      'UPDATE notification_event SET dispatched_at = NULL WHERE org_id = ?',
      actor.orgId,
    );
    await run(
      context.executor,
      "UPDATE job SET state = 'dead' WHERE org_id = ? AND type = 'core:notification-dispatch:v1'",
      actor.orgId,
    );
    await seeder(context.executor).forged(
      `INSERT INTO job (id, org_id, type, idempotency_key, state) VALUES ('foreign-dispatch', ?, 'core:notification-dispatch:v1', ?, 'queued')`,
      other.orgId,
      `core:notification-dispatch:v1:dispatch:${stalled!.operationId}:1`,
    );
    await run(
      context.executor,
      "UPDATE job SET state = 'queued' WHERE org_id = ? AND idempotency_key = ?",
      actor.orgId,
      `core:notification-dispatch:v1:dispatch:${live!.operationId}:1`,
    );
    await twin(context, 'notification_event', actor, other, (row) => ({
      id: `F-${String(row.id)}`,
    }));
    await seeder(context.executor).forged(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, ?, 'F-OLD', 'F-OLD-OP', 'npm.package.published', 'S-hosted', 'x', '{}', '2026-01-01T00:00:00.000Z')`,
      other.orgId,
      PROJECT_A,
    );
    const ids = [ulid(), ulid(), ulid()];
    const restarted = await attempt(
      repo(context).redispatch(actor, SWEEP, {
        now: at(HOUR),
        limit: 1,
        jobId: () => ids.shift()!,
      }),
    );
    expect(restarted === 'error' ? restarted : restarted.length).toBe(1);
    expect(
      await rows(
        context.executor,
        "SELECT DISTINCT dispatch_generation FROM notification_event WHERE org_id = ? AND id <> 'F-OLD'",
        other.orgId,
      ),
    ).toEqual([{ dispatch_generation: 1 }]);
  },
};

/** Wraps the case executor so the own event finishes dispatch right after the sweep listed it. */
function racing(context: CaseContext, actor: OrgContext): SqlExecutor {
  const inner = executing(context);
  return {
    driver: inner.driver,
    async all<R>(statement: Statement) {
      const result = await inner.all<R>(statement);
      await run(
        context.executor,
        'UPDATE notification_event SET dispatched_at = ? WHERE org_id = ?',
        NOW,
        actor.orgId,
      );
      return result;
    },
    batch: (statements: readonly Statement[]) => inner.batch(statements),
  };
}

const redispatchGuardTwin: ContractCase = {
  name: 'redispatch rechecks the own operation, not a foreign twin event',
  async run(context) {
    const { actor, other } = await armed(context);
    await run(
      context.executor,
      'UPDATE notification_event SET dispatched_at = NULL WHERE org_id = ?',
      actor.orgId,
    );
    await run(
      context.executor,
      "UPDATE job SET state = 'dead' WHERE org_id = ? AND type = 'core:notification-dispatch:v1'",
      actor.orgId,
    );
    await twin(context, 'notification_event', actor, other, (row) => ({
      id: `F-${String(row.id)}`,
    }));
    const restarted = await attempt(
      createNotificationRetentionRepository(racing(context, actor)).redispatch(actor, SWEEP, {
        now: at(HOUR),
        limit: 100,
        jobId: ulid,
      }),
    );
    expect(restarted).toEqual([]);
  },
};

/** Finishes the own deliveries at `finishedAt`. */
async function finish(context: CaseContext, actor: OrgContext, finishedAt: string) {
  await run(
    context.executor,
    "UPDATE notification_delivery SET state = 'delivered', outcome_code = 'ok', finished_at = ? WHERE org_id = ?",
    finishedAt,
    actor.orgId,
  );
}

const YOUNG = at(29 * 24 * HOUR + HOUR);
const PRUNE = { now: at(30 * 24 * HOUR), before: at(29 * 24 * HOUR), limit: 100 };
const prune = (context: CaseContext, actor: OrgContext) =>
  attempt(repo(context).prune(actor, SWEEP, PRUNE));

const pruneSelectDeliveryTwin: ContractCase = {
  name: 'prune keeps young own history whose ids old foreign history shares',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await finish(context, actor, YOUNG);
    await run(
      context.executor,
      `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
       VALUES (?, ?, ?, 1, 'J', 1, 'delivered', 'ok', ?, ?)`,
      actor.orgId,
      String(delivery.project_id),
      String(delivery.id),
      NOW,
      NOW,
    );
    await twin(context, 'notification_delivery', actor, other, { finished_at: NOW });
    await prune(context, actor);
    expect(
      await one(
        context,
        `SELECT (SELECT count(*) FROM notification_delivery WHERE org_id = ?) AS deliveries,
          (SELECT count(*) FROM notification_attempt WHERE org_id = ?) AS attempts`,
        actor.orgId,
        actor.orgId,
      ),
    ).toEqual({ deliveries: 1, attempts: 1 });
  },
};

const pruneSelectEventTwin: ContractCase = {
  name: 'prune keeps young own emptied events and deleted endpoints that old foreign twins share',
  async run(context) {
    const { actor, other } = await armed(context);
    await run(context.executor, 'DELETE FROM notification_delivery WHERE org_id = ?', actor.orgId);
    await run(
      context.executor,
      "UPDATE notification_endpoint SET state = 'deleted', disabled_reason = NULL WHERE org_id = ?",
      actor.orgId,
    );
    await twin(context, 'notification_event', actor, other);
    await twin(context, 'notification_endpoint', actor, other);
    await run(
      context.executor,
      'UPDATE notification_event SET occurred_at = ? WHERE org_id = ?',
      YOUNG,
      actor.orgId,
    );
    await run(
      context.executor,
      'UPDATE notification_endpoint SET updated_at = ? WHERE org_id = ?',
      YOUNG,
      actor.orgId,
    );
    await prune(context, actor);
    expect(
      await one(
        context,
        `SELECT (SELECT count(*) FROM notification_event WHERE org_id = ?) AS events,
          (SELECT count(*) FROM notification_endpoint WHERE org_id = ?) AS endpoints`,
        actor.orgId,
        actor.orgId,
      ),
    ).toEqual({ events: 1, endpoints: 1 });
  },
};

const pruneDeleteTwin: ContractCase = {
  name: 'prune deletes own old history and leaves foreign rows that share its ids',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await finish(context, actor, NOW);
    await run(
      context.executor,
      `INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, outcome_code, started_at, finished_at)
       VALUES (?, ?, ?, 1, 'J', 1, 'delivered', 'ok', ?, ?)`,
      actor.orgId,
      String(delivery.project_id),
      String(delivery.id),
      NOW,
      NOW,
    );
    await run(
      context.executor,
      "UPDATE notification_endpoint SET state = 'deleted', disabled_reason = NULL WHERE org_id = ?",
      actor.orgId,
    );
    for (const table of [
      'notification_delivery',
      'notification_attempt',
      'notification_event',
      'notification_endpoint',
    ] as const)
      await twin(context, table, actor, other);
    const result = await prune(context, actor);
    expect(result === 'error' ? result : result.credentials).toBe(1);
    expect(
      await one(
        context,
        `SELECT (SELECT count(*) FROM notification_delivery WHERE org_id = ?) AS deliveries,
          (SELECT count(*) FROM notification_attempt WHERE org_id = ?) AS attempts,
          (SELECT count(*) FROM notification_event WHERE org_id = ?) AS events,
          (SELECT count(*) FROM notification_endpoint WHERE org_id = ?) AS endpoints`,
        other.orgId,
        other.orgId,
        other.orgId,
        other.orgId,
      ),
    ).toEqual({ deliveries: 1, attempts: 1, events: 1, endpoints: 1 });
  },
};

const pruneReferenceTwin: ContractCase = {
  name: 'prune ignores foreign rows that name own emptied events, endpoints and credentials',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await run(
      context.executor,
      "UPDATE notification_endpoint SET state = 'deleted', disabled_reason = NULL WHERE org_id = ?",
      actor.orgId,
    );
    await twin(context, 'notification_delivery', actor, other);
    await twin(context, 'notification_endpoint', actor, other, { state: 'enabled' });
    await run(context.executor, 'DELETE FROM notification_delivery WHERE org_id = ?', actor.orgId);
    await prune(context, actor);
    expect(
      await one(
        context,
        `SELECT (SELECT count(*) FROM notification_event WHERE org_id = ?) AS events,
          (SELECT count(*) FROM notification_endpoint WHERE org_id = ?) AS endpoints,
          (SELECT count(*) FROM credential WHERE org_id = ? AND id = ?) AS credentials`,
        actor.orgId,
        actor.orgId,
        actor.orgId,
        String(delivery.configuration_credential_id),
      ),
    ).toEqual({ events: 0, endpoints: 0, credentials: 0 });
  },
};

const pruneBodyReferenceTwin: ContractCase = {
  name: 'prune ignores a foreign delivery that names an own body credential',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await run(
      context.executor,
      "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad, created_at) VALUES ('C-body', ?, ?, 'npm-notification-body', x'00', zeroblob(12), 1, 'aad', ?)",
      actor.orgId,
      String(delivery.project_id),
      NOW,
    );
    await twin(context, 'notification_delivery', actor, other, {
      body_credential_id: 'C-body',
      configuration_credential_id: 'C-body',
    });
    await prune(context, actor);
    expect(await one(context, "SELECT count(*) AS n FROM credential WHERE id = 'C-body'")).toEqual({
      n: 0,
    });
  },
};

const LOCATORS = {
  retained: /retained\.org_id = \?/,
  delivery: /repair_delivery\.org_id = \?/,
  event: /repair_event\.org_id = \?/,
  endpoint: /repair_endpoint\.org_id = \?/,
  source: /repair_source\.org_id = \?/,
  attempt: /repair_attempt\.org_id = \?/,
  expiring: /expiring\.org_id = \?/,
  expireUpdate: /(?<=update notification_delivery set state = 'failed'[^;]*?where )org_id = \?/,
  orphan: /orphan\.org_id = \?/,
  unknownAttempt: /(?<=update notification_attempt set outcome = 'unknown'[^;]*?where )org_id = \?/,
  orphanUpdate:
    /(?<=update notification_delivery set state = \?, outcome_code = \?,\s+next_attempt_at[^;]*?where )org_id = \?/,
  cancelling: /cancelling\.org_id = \?/,
  cancelUpdate:
    /(?<=update notification_delivery set state = 'cancelled', outcome_code = \?[^;]*?where )org_id = \?/,
  requeued: /requeued\.org_id = \?/,
  requeueJob: /requeue_job\.org_id = \?/,
  requeueUpdate: /(?<=update notification_delivery set job_generation[^;]*?\n\s*where )org_id = \?/,
  requeueRead: /requeue_read\.org_id = \?/,
  stalled: /stalled\.org_id = \?/,
  stalledJob: /stalled_job\.org_id = \?/,
  restarting: /restarting\.org_id = \?/,
  restartUpdate: /(?<=update notification_event set dispatch_generation[^;]*?where )org_id = \?/,
  pruned: /pruned\.org_id = \?/,
  attemptDelete: /(?<=delete from notification_attempt where )org_id = \?/,
  deliveryDelete: /(?<=delete from notification_delivery where )org_id = \?/,
  eventDelete: /(?<=delete from notification_event where )org_id = \?/,
  endpointDelete: /(?<=delete from notification_endpoint where )org_id = \?/,
  emptied: /emptied\.org_id = \?/,
  emptiedRef: /emptied_ref\.org_id = \?/,
  gone: /gone\.org_id = \?/,
  goneRef: /gone_ref\.org_id = \?/,
  unusedEndpoint: /unused_endpoint\.org_id = \?/,
  unusedDelivery: /unused_delivery\.org_id = \?/,
};

const SHARED = [
  {
    locate: /(?<![\w.])job\.org_id = \?/,
    reason: 'jobLeaseGuard is registered by job-lease-guard.ts.',
  },
  {
    locate: /(?:repair_sending_job|repair_pending_job|orphan_job|requeued_job)\.org_id = \?/,
    reason:
      "job.id is the primary key, so the lookup of a delivery's active job cannot reach another organization; the comparison is defensive.",
  },
  {
    locate: /unused\.org_id = \?|(?<=delete from credential where )org_id = \?/,
    reason:
      'credential.id is the primary key: a foreign credential the selection could name never matches the own-scoped delete, so a dropped comparison only spends page slots of the own sweep; no foreign row changes.',
  },
  {
    locate: /repair_ps\.org_id = \?/,
    reason:
      'project_source is unique on (project_id, source_id), so the attachment of the delivery project to the event source cannot belong to another organization; the comparison is defensive.',
  },
  {
    locate: /repair_project\.org_id = \?/,
    reason:
      'project.id is the primary key, so the join on the delivery project cannot reach another organization; the comparison is defensive.',
  },
  {
    locate:
      /marked\.org_id = \?|streak\.org_id = \?|(?<=update notification_endpoint set failure_streak = failure_streak \+ 1,[^;]*?where )org_id = \?|(?<=update notification_delivery set state = 'cancelled', outcome_code = 'disabled'[^;]*?where )org_id = \?/,
    reason:
      'failureStreakStatements is registered through createNotificationSettlement in notification-attempt.ts.',
  },
  {
    locate:
      /(?<=FROM project WHERE id = \? AND )org_id = \?|(?<=from project where id = \? and )org_id = \?/i,
    reason: 'Job inserts are registered by job-factory.ts.',
  },
  {
    locate:
      /(?:cap_\w+|capture|dispatch_delivery|dispatch_event|unscheduled|scheduled|remaining|remaining_event|open_event|recorded)\.org_id = \?|(?<=update notification_event set dispatched_at[^;]*?where )org_id = \?|(?<=update notification_delivery set active_job_id[^;]*?\n\s*where )org_id = \?|(?<=delete from notification_(?:delivery|event) where )org_id = \?(?=[^;]*cap_)/,
    reason:
      'Capture and dispatch statements that arrange the case are registered by their own entries.',
  },
];

function entry(contractCase: ContractCase, locate: RegExp, copies = 1): MutationEntry {
  return {
    file: 'repositories/notification-retention.ts',
    builder: 'createNotificationRetentionRepository',
    cases: [contractCase],
    predicates: [
      {
        name: `${contractCase.name} (${locate.source})`,
        caseName: contractCase.name,
        locate,
        neutral: '(? is not null)',
        copies,
      },
    ],
    waivers: [
      ...SHARED,
      ...Object.values(LOCATORS)
        .filter((other) => other.source !== locate.source)
        .map((other) => ({ locate: other, reason: 'Registered by another entry of this module.' })),
    ],
  };
}

export const entries: readonly MutationEntry[] = [
  entry(candidatesDeliveryTwin, LOCATORS.delivery),
  entry(candidatesJoinTwin, LOCATORS.event),
  entry(candidatesJoinTwin, LOCATORS.attempt),
  entry(candidatesEndpointTwin, LOCATORS.endpoint),
  entry(candidatesSourceTwin, LOCATORS.source, 2),
  entry(expireRowsTwin, LOCATORS.retained),
  entry(expireGuardTwin, LOCATORS.expiring),
  entry(expireRowsTwin, LOCATORS.expireUpdate),
  entry(orphanGuardTwin, LOCATORS.orphan),
  entry(orphanRowsTwin, LOCATORS.unknownAttempt),
  entry(orphanRowsTwin, LOCATORS.orphanUpdate),
  entry(cancelGuardTwin, LOCATORS.cancelling),
  entry(cancelRowsTwin, LOCATORS.cancelUpdate),
  entry(requeueGuardTwin, LOCATORS.requeued),
  entry(requeueRowsTwin, LOCATORS.requeueJob),
  entry(requeueRowsTwin, LOCATORS.requeueUpdate),
  entry(requeueRowsTwin, LOCATORS.requeueRead),
  entry(redispatchTwin, LOCATORS.stalled),
  entry(redispatchTwin, LOCATORS.stalledJob),
  entry(redispatchTwin, LOCATORS.restartUpdate),
  entry(redispatchGuardTwin, LOCATORS.restarting),
  entry(pruneSelectDeliveryTwin, LOCATORS.pruned, 2),
  entry(pruneSelectEventTwin, LOCATORS.emptied),
  entry(pruneSelectEventTwin, LOCATORS.gone),
  entry(pruneDeleteTwin, LOCATORS.attemptDelete),
  entry(pruneDeleteTwin, LOCATORS.deliveryDelete),
  entry(pruneDeleteTwin, LOCATORS.eventDelete),
  entry(pruneDeleteTwin, LOCATORS.endpointDelete),
  entry(pruneReferenceTwin, LOCATORS.emptiedRef),
  entry(pruneReferenceTwin, LOCATORS.goneRef),
  entry(pruneReferenceTwin, LOCATORS.unusedEndpoint),
  entry(pruneBodyReferenceTwin, LOCATORS.unusedDelivery),
];
