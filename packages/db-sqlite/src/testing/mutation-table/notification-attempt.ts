import { expect } from 'vitest';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import type { NotificationSettle } from '@package-broker/core/db/notifications';
import type { OrgContext, SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createNotificationAttemptRepository } from '../../repositories/notification-attempt.js';
import { createNotificationDispatchRepository } from '../../repositories/notification-dispatch.js';
import { rows, run } from '../../contract/notification-fixture.js';
import { captured, leaseJob } from './notification-dispatch.js';
import { executing } from './factory-cases.js';
import { seeder, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

const LATER = '2026-11-01T12:00:01.000Z';
type Row = Record<string, SqlValue>;

/**
 * The acting organization is the second fixture organization, so a twin row of the first one
 * sorts ahead of it in every (org_id, …) index and a dropped comparison reaches the twin.
 */
async function armed(context: CaseContext, reserve: boolean) {
  const { own: actor, foreign: other } = await captured(context, 1, 1, true);
  const [operation] = await rows<{ operation_id: string }>(
    context.executor,
    'SELECT operation_id FROM notification_event WHERE org_id = ?',
    actor.orgId,
  );
  await createNotificationDispatchRepository(context.executor).dispatchPage(
    actor,
    { id: 'dispatch-job', owner: 'owner', fence: 1 },
    operation!.operation_id,
  );
  const [delivery] = await rows<Row>(
    context.executor,
    'SELECT * FROM notification_delivery WHERE org_id = ?',
    actor.orgId,
  );
  const job = await leaseJob(context.executor, actor, String(delivery!.active_job_id));
  if (reserve)
    await createNotificationAttemptRepository(context.executor).reserve(actor, job, {
      deliveryId: String(delivery!.id),
      expectedRevision: 1,
      now: LATER,
      event: audit('notification.delivery_started', actor, delivery!, 1),
    });
  return { actor, other, delivery: delivery!, job };
}

let twins = 0;

/** Copies the acting organization's rows into the other organization, ahead of them in rowid order. */
async function twin(
  context: CaseContext,
  table:
    | 'notification_delivery'
    | 'notification_endpoint'
    | 'notification_attempt'
    | 'notification_event',
  from: OrgContext,
  to: OrgContext,
  overrides: Row = {},
) {
  const found = await rows<Row>(
    context.executor,
    `SELECT * FROM ${table} WHERE org_id = ?`,
    from.orgId,
  );
  for (const row of found) {
    twins -= 1;
    const copy: Row = { rowid: twins, ...row, org_id: to.orgId, ...overrides };
    const columns = Object.keys(copy);
    await seeder(context.executor).forged(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...(Object.values(copy) as (string | number | null)[]),
    );
  }
}

function audit(
  action: 'notification.delivery_started' | 'notification.delivery_finished',
  actor: OrgContext,
  delivery: Row,
  attempt: number,
  extra: Record<string, SqlValue> = {},
): AuditEvent {
  void actor;
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

function failure(actor: OrgContext, delivery: Row, over: Partial<NotificationSettle> = {}) {
  return {
    deliveryId: String(delivery.id),
    attempt: 1,
    expectedRevision: 2,
    now: LATER,
    outcome: 'failed' as const,
    code: 'http_permanent' as const,
    status: 400,
    durationMs: 5,
    delivery: { state: 'failed' as const, code: 'http_permanent' as const },
    disable: null,
    event: audit('notification.delivery_finished', actor, delivery, 1, {
      outcome: 'failed',
      reason: 'http_permanent',
      status: 400,
      duration_ms: 5,
      delivery_state: 'failed',
    }),
    ...over,
  };
}

const repo = (context: CaseContext) => createNotificationAttemptRepository(executing(context));
const attempt = <T>(promise: Promise<T>) => promise.catch(() => 'error' as const);
const one = async (context: CaseContext, sql: string, ...params: SqlValue[]) =>
  (await rows<Row>(context.executor, sql, ...params))[0];

function reserveInput(actor: OrgContext, delivery: Row, attemptNumber = 1, revision = 1) {
  return {
    deliveryId: String(delivery.id),
    expectedRevision: revision,
    now: LATER,
    event: audit('notification.delivery_started', actor, delivery, attemptNumber),
  };
}

const loadTwin: ContractCase = {
  name: 'load reads only the own delivery and its own attempts',
  async run(context) {
    const { actor, other, delivery } = await armed(context, true);
    await twin(context, 'notification_delivery', actor, other, {
      state: 'failed',
      finished_at: LATER,
    });
    await twin(context, 'notification_attempt', actor, other, {
      outcome: 'failed',
      finished_at: '2026-11-01T13:00:00.000Z',
    });
    const loaded = await attempt(repo(context).load(actor, String(delivery.id)));
    expect(loaded === 'error' ? loaded : [loaded?.state, loaded?.lastFinishedAt]).toEqual([
      'sending',
      null,
    ]);
  },
};

const reserveReadyTwin: ContractCase = {
  name: 'reserve refuses when only a foreign twin of the delivery is ready',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    await twin(context, 'notification_delivery', actor, other, { revision: 5 });
    expect(
      await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery, 1, 5))),
    ).toEqual({ ok: false });
  },
};

const reserveEndpointTwin: ContractCase = {
  name: 'reserve refuses a disabled own endpoint next to an enabled foreign twin',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    await twin(context, 'notification_endpoint', actor, other);
    await run(
      context.executor,
      "UPDATE notification_endpoint SET state = 'disabled', disabled_reason = 'manual' WHERE org_id = ?",
      actor.orgId,
    );
    expect(await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery)))).toEqual(
      {
        ok: false,
      },
    );
  },
};

const reserveEventTwin: ContractCase = {
  name: 'reserve refuses an own event of a detached source next to a foreign twin of an attached one',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    await twin(context, 'notification_event', actor, other);
    await run(
      context.executor,
      "UPDATE notification_event SET source_id = 'S-detached' WHERE org_id = ?",
      actor.orgId,
    );
    expect(await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery)))).toEqual(
      { ok: false },
    );
  },
};

const reserveAttachmentTwin: ContractCase = {
  name: 'reserve refuses a source attached to the project only in another organization',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    const [attachment] = await rows<{ project_id: string; source_id: string }>(
      context.executor,
      'SELECT project_id, source_id FROM project_source WHERE org_id = ? AND project_id = ?',
      actor.orgId,
      String(delivery.project_id),
    );
    await seeder(context.executor).forged(
      'DELETE FROM project_source WHERE org_id = ? AND project_id = ?',
      actor.orgId,
      String(delivery.project_id),
    );
    await seeder(context.executor).forged(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      other.orgId,
      attachment!.project_id,
      attachment!.source_id,
    );
    expect(await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery)))).toEqual(
      { ok: false },
    );
  },
};

const reserveSourceTwin: ContractCase = {
  name: 'reserve refuses an attached source of another organization',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    const forged = seeder(context.executor).forged;
    await forged(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S-foreign', ?, 'Foreign', 'npm', 'hosted')",
      other.orgId,
    );
    await forged(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'S-foreign')",
      actor.orgId,
      String(delivery.project_id),
    );
    await run(
      context.executor,
      "UPDATE notification_event SET source_id = 'S-foreign' WHERE org_id = ?",
      actor.orgId,
    );
    expect(await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery)))).toEqual(
      { ok: false },
    );
  },
};

const reserveBusyTwin: ContractCase = {
  name: "reserve ignores another organization's send to an endpoint with the same id",
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    await twin(context, 'notification_delivery', actor, other, {
      state: 'sending',
      active_fence: 1,
    });
    expect(await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery)))).toEqual(
      {
        ok: true,
        attempt: 1,
        revision: 2,
      },
    );
  },
};

const reserveTwin: ContractCase = {
  name: 'reserve changes, counts and reports only the own delivery',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, false);
    await twin(context, 'notification_delivery', actor, other);
    expect(await attempt(repo(context).reserve(actor, job, reserveInput(actor, delivery)))).toEqual(
      {
        ok: true,
        attempt: 1,
        revision: 2,
      },
    );
    expect(
      await one(
        context,
        'SELECT state, attempts, (SELECT count(*) FROM notification_attempt WHERE org_id = ?) AS started FROM notification_delivery WHERE org_id = ?',
        other.orgId,
        other.orgId,
      ),
    ).toEqual({ state: 'pending', attempts: 0, started: 0 });
  },
};

const settleStreakTwin: ContractCase = {
  name: "settlement counts the own endpoint's streak, not a foreign twin's",
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_endpoint', actor, other, { failure_streak: 9 });
    await attempt(repo(context).settle(actor, job, failure(actor, delivery)));
    expect(
      await one(
        context,
        'SELECT state, failure_streak FROM notification_endpoint WHERE org_id = ?',
        actor.orgId,
      ),
    ).toEqual({ state: 'enabled', failure_streak: 1 });
    expect(
      await one(
        context,
        'SELECT state, failure_streak FROM notification_endpoint WHERE org_id = ?',
        other.orgId,
      ),
    ).toEqual({ state: 'enabled', failure_streak: 9 });
  },
};

const settleRevisionTwin: ContractCase = {
  name: 'settlement leaves a changed endpoint alone even when a foreign twin delivery matches it',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_delivery', actor, other, { endpoint_revision: 2 });
    await run(
      context.executor,
      'UPDATE notification_endpoint SET revision = 2 WHERE org_id = ?',
      actor.orgId,
    );
    await attempt(repo(context).settle(actor, job, failure(actor, delivery)));
    expect(
      await one(
        context,
        'SELECT failure_streak FROM notification_endpoint WHERE org_id = ?',
        actor.orgId,
      ),
    ).toEqual({ failure_streak: 0 });
  },
};

const settleFenceTwin: ContractCase = {
  name: 'settlement refuses a stale attempt even when a foreign twin matches it',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_delivery', actor, other, { attempts: 2 });
    expect(
      await attempt(repo(context).settle(actor, job, failure(actor, delivery, { attempt: 2 }))),
    ).toBe(false);
  },
};

const settleRowsTwin: ContractCase = {
  name: 'settlement finishes only the own attempt, delivery and endpoint',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    for (const table of [
      'notification_delivery',
      'notification_attempt',
      'notification_endpoint',
    ] as const)
      await twin(context, table, actor, other);
    await run(
      context.executor,
      'UPDATE notification_endpoint SET failure_streak = 4 WHERE org_id IN (?, ?)',
      actor.orgId,
      other.orgId,
    );
    expect(await attempt(repo(context).settle(actor, job, failure(actor, delivery)))).toBe(true);
    expect(
      await one(
        context,
        `SELECT d.state, a.outcome, e.failure_streak FROM notification_delivery d
         JOIN notification_attempt a ON a.org_id = d.org_id AND a.delivery_id = d.id
         JOIN notification_endpoint e ON e.org_id = d.org_id AND e.id = d.endpoint_id WHERE d.org_id = ?`,
        other.orgId,
      ),
    ).toEqual({ state: 'sending', outcome: 'started', failure_streak: 4 });
  },
};

const settleResetTwin: ContractCase = {
  name: "a delivered settlement resets only the own endpoint's streak",
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_endpoint', actor, other, { failure_streak: 4 });
    await attempt(
      repo(context).settle(
        actor,
        job,
        failure(actor, delivery, {
          outcome: 'delivered',
          code: 'ok',
          status: 200,
          delivery: { state: 'delivered', code: 'ok' },
        }),
      ),
    );
    expect(
      await one(
        context,
        'SELECT failure_streak FROM notification_endpoint WHERE org_id = ?',
        other.orgId,
      ),
    ).toEqual({ failure_streak: 4 });
  },
};

const settleDisableTwin: ContractCase = {
  name: 'auto-disable disables and cancels only the own endpoint and its waiting work',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_endpoint', actor, other);
    await twin(context, 'notification_delivery', actor, other, {
      id: '00000000-twin',
      state: 'pending',
      active_fence: null,
    });
    await run(
      context.executor,
      'UPDATE notification_endpoint SET failure_streak = 9 WHERE org_id IN (?, ?)',
      actor.orgId,
      other.orgId,
    );
    expect(await attempt(repo(context).settle(actor, job, failure(actor, delivery)))).toBe(true);
    expect(
      await one(
        context,
        `SELECT e.state, (SELECT state FROM notification_delivery WHERE org_id = e.org_id) AS waiting
         FROM notification_endpoint e WHERE e.org_id = ?`,
        other.orgId,
      ),
    ).toEqual({ state: 'enabled', waiting: 'pending' });
    expect(
      await one(context, 'SELECT state FROM notification_endpoint WHERE org_id = ?', actor.orgId),
    ).toEqual({ state: 'disabled' });
    const disabled = await one(
      context,
      "SELECT payload_json FROM audit_pending WHERE org_id = ? AND action = 'notification.auto_disable'",
      actor.orgId,
    );
    expect(JSON.parse(String(disabled?.payload_json))).toMatchObject({
      changes: { failure_streak: { new: 10 } },
    });
  },
};

function unknown(actor: OrgContext, delivery: Row) {
  return {
    deliveryId: String(delivery.id),
    now: LATER,
    delivery: { state: 'pending' as const, nextAttemptAt: '2026-11-01T12:05:00.000Z' },
    event: audit('notification.delivery_finished', actor, delivery, 1, {
      outcome: 'unknown',
      reason: 'unknown',
      status: null,
      delivery_state: 'pending',
    }),
  };
}

const reconcileGuardTwin: ContractCase = {
  name: 'reconcile refuses the current claim even when a foreign twin is orphaned',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_delivery', actor, other);
    const reclaimed = await leaseJob(context.executor, actor, job.id, 2);
    await run(
      context.executor,
      'UPDATE notification_delivery SET active_fence = 2 WHERE org_id = ?',
      actor.orgId,
    );
    expect(await attempt(repo(context).reconcile(actor, reclaimed, unknown(actor, delivery)))).toBe(
      false,
    );
  },
};

const reconcileRowsTwin: ContractCase = {
  name: 'reconcile resolves only the own orphaned attempt and delivery',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context, true);
    await twin(context, 'notification_delivery', actor, other);
    await twin(context, 'notification_attempt', actor, other);
    const reclaimed = await leaseJob(context.executor, actor, job.id, 2);
    expect(await attempt(repo(context).reconcile(actor, reclaimed, unknown(actor, delivery)))).toBe(
      true,
    );
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

const LOCATORS = {
  loadDelivery: /load_delivery\.org_id = \?/,
  loadAttempt: /load_attempt\.org_id = \?/,
  readyDelivery: /reserve_delivery\.org_id = \?/,
  readyEndpoint: /reserve_endpoint\.org_id = \?/,
  busy: /reserve_busy\.org_id = \?/,
  readyEvent: /reserve_event\.org_id = \?/,
  readyAttachment: /reserve_ps\.org_id = \?/,
  readySource: /reserve_source\.org_id = \?/,
  reserveUpdate: /(?<=update notification_delivery set state = 'sending'[^;]*?where )org_id = \?/,
  started: /started\.org_id = \?/,
  audited: /audited\.org_id = \?/,
  snapshot: /snapshot\.org_id = \?/,
  streakAudit: /streak\.org_id = \?/,
  settling: /settling\.org_id = \?/,
  attemptUpdate: /(?<=update notification_attempt set outcome = \?[^;]*?where )org_id = \?/,
  deliveryUpdate: /(?<=update notification_delivery set state = \?[^;]*?where )org_id = \?/,
  reset: /(?<=update notification_endpoint set failure_streak = 0[^;]*?where )org_id = \?/,
  count:
    /(?<=update notification_endpoint set failure_streak = failure_streak \+ 1,[^;]*?where )org_id = \?/,
  cancel: /(?<=update notification_delivery set state = 'cancelled'[^;]*?where )org_id = \?/,
  orphaned: /orphaned\.org_id = \?/,
  unknownAttempt: /(?<=update notification_attempt set outcome = 'unknown'[^;]*?where )org_id = \?/,
};

const SHARED = [
  { locate: /job\.org_id = \?/, reason: 'jobLeaseGuard is registered by job-lease-guard.ts.' },
  {
    locate: /reserve_project\.org_id = \?/,
    reason:
      'project.id is the primary key, so the join on the delivery project cannot reach another organization; the comparison is defensive.',
  },
  {
    locate: /marked\.org_id = \?/,
    reason:
      'The marker is the fresh audit id this batch writes to the disabled endpoint; no other row can carry it, so the comparison is defensive.',
  },
  {
    locate: /(?<=FROM project WHERE id = \? AND )org_id = \?/,
    reason: 'Job inserts made while arranging the case are registered by job-factory.ts.',
  },
  {
    locate:
      /(?:dispatch_delivery|dispatch_event|unscheduled|scheduled|remaining|remaining_event|open_event|recorded)\.org_id = \?|(?<=update notification_event set dispatched_at[^;]*?where )org_id = \?|(?<=update notification_delivery set active_job_id[^;]*?\n\s*where )org_id = \?/,
    reason: 'Dispatch statements that arrange the case are registered by notification-dispatch.ts.',
  },
];

function entry(
  builder: string,
  file: string,
  contractCase: ContractCase,
  locate: RegExp,
  copies = 1,
): MutationEntry {
  return {
    file: `repositories/${file}.ts`,
    builder,
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

const ATTEMPT = ['createNotificationAttemptRepository', 'notification-attempt'] as const;
const SETTLE = ['createNotificationSettlement', 'notification-settle'] as const;

export const entries: readonly MutationEntry[] = [
  entry(...ATTEMPT, loadTwin, LOCATORS.loadDelivery),
  entry(...ATTEMPT, loadTwin, LOCATORS.loadAttempt),
  entry(...ATTEMPT, reserveReadyTwin, LOCATORS.readyDelivery),
  entry(...ATTEMPT, reserveEndpointTwin, LOCATORS.readyEndpoint),
  entry(...ATTEMPT, reserveBusyTwin, LOCATORS.busy),
  entry(...ATTEMPT, reserveEventTwin, LOCATORS.readyEvent),
  entry(...ATTEMPT, reserveAttachmentTwin, LOCATORS.readyAttachment),
  entry(...ATTEMPT, reserveSourceTwin, LOCATORS.readySource),
  entry(...ATTEMPT, reserveTwin, LOCATORS.reserveUpdate),
  entry(...ATTEMPT, reserveTwin, LOCATORS.started),
  entry(...ATTEMPT, reserveTwin, LOCATORS.audited),
  entry(...SETTLE, settleStreakTwin, LOCATORS.count),
  entry(...SETTLE, settleRevisionTwin, LOCATORS.snapshot),
  entry(...SETTLE, settleFenceTwin, LOCATORS.settling),
  entry(...SETTLE, settleRowsTwin, LOCATORS.attemptUpdate),
  entry(...SETTLE, settleRowsTwin, LOCATORS.deliveryUpdate),
  entry(...SETTLE, settleRowsTwin, LOCATORS.count),
  entry(...SETTLE, settleResetTwin, LOCATORS.reset),
  entry(...SETTLE, settleDisableTwin, LOCATORS.count),
  entry(...SETTLE, settleDisableTwin, LOCATORS.streakAudit),
  entry(...SETTLE, settleDisableTwin, LOCATORS.cancel),
  entry(...SETTLE, reconcileGuardTwin, LOCATORS.orphaned),
  entry(...SETTLE, reconcileRowsTwin, LOCATORS.unknownAttempt),
  entry(...SETTLE, reconcileRowsTwin, LOCATORS.deliveryUpdate),
];
