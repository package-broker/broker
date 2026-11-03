import { expect } from 'vitest';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createNotificationDispatchRepository } from '../../repositories/notification-dispatch.js';
import { createNotificationPrepareRepository } from '../../repositories/notification-prepare.js';
import { PROJECT_A, rows, run } from '../../contract/notification-fixture.js';
import { captured, leaseJob } from './notification-dispatch.js';
import { executing } from './factory-cases.js';
import { seeder, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

const LATER = '2026-11-01T12:00:01.000Z';
type Row = Record<string, SqlValue>;

/** Acts as the second fixture organization so a first-organization twin sorts ahead of it. */
async function armed(context: CaseContext) {
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
  return { actor, other, delivery: delivery!, job };
}

let twins = 0;

async function twin(
  context: CaseContext,
  table: string,
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
  action: 'notification.delivery_cancelled' | 'notification.delivery_finished',
  delivery: Row,
  reason: string,
): AuditEvent {
  const fields: Record<string, SqlValue> = {
    endpoint_id: String(delivery.endpoint_id),
    event_id: String(delivery.event_id),
    delivery_id: String(delivery.id),
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

function body(ctx: OrgContext, id: string): Statement {
  return {
    sql: "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, 'npm-notification-body', x'00', zeroblob(12), 1, 'aad')",
    params: [id, ctx.orgId, PROJECT_A],
  };
}

const repo = (context: CaseContext) => createNotificationPrepareRepository(executing(context));
const attempt = <T>(promise: Promise<T>) => promise.catch(() => 'error' as const);
const one = async (context: CaseContext, sql: string, ...params: SqlValue[]) =>
  (await rows<Row>(context.executor, sql, ...params))[0];

const contextTwin: ContractCase = {
  name: 'context reads only the own delivery, attempts, event and endpoint',
  async run(context) {
    const { actor, other, delivery } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, {
      state: 'cancelled',
      finished_at: LATER,
      outcome_code: 'deleted',
    });
    await twin(context, 'notification_event', actor, other, { payload_json: '{"twin":true}' });
    await twin(context, 'notification_endpoint', actor, other, {
      state: 'disabled',
      disabled_reason: 'manual',
      revision: 7,
    });
    await seeder(context.executor).forged(
      "INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at, finished_at) VALUES (?, ?, ?, 1, 'j', 1, 'failed', ?, ?)",
      other.orgId,
      String(delivery.project_id),
      String(delivery.id),
      LATER,
      LATER,
    );
    const read = await attempt(repo(context).context(actor, String(delivery.id)));
    expect(
      read === 'error' || read === null
        ? read
        : [
            read.delivery.state,
            read.delivery.lastFinishedAt,
            read.payloadJson.includes('twin'),
            read.endpoint,
          ],
    ).toEqual(['pending', null, false, { state: 'enabled', revision: 1, method: 'POST' }]);
  },
};

const attachClaimTwin: ContractCase = {
  name: 'attach refuses when only a foreign twin is claimed and unsealed',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_delivery', actor, other);
    await run(
      context.executor,
      "UPDATE notification_delivery SET active_job_id = 'elsewhere' WHERE org_id = ?",
      actor.orgId,
    );
    const id = ulid();
    expect(
      await attempt(
        repo(context).attachBody(actor, job, {
          deliveryId: String(delivery.id),
          expectedRevision: 1,
          credentialId: id,
          statement: body(actor, id),
        }),
      ),
    ).toBe(false);
  },
};

const attachSealedTwin: ContractCase = {
  name: 'attach refuses an already sealed own delivery next to an unsealed twin',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_delivery', actor, other);
    const sealed = ulid();
    await run(context.executor, body(actor, sealed).sql, ...body(actor, sealed).params);
    await run(
      context.executor,
      'UPDATE notification_delivery SET body_credential_id = ? WHERE org_id = ?',
      sealed,
      actor.orgId,
    );
    const id = ulid();
    expect(
      await attempt(
        repo(context).attachBody(actor, job, {
          deliveryId: String(delivery.id),
          expectedRevision: 1,
          credentialId: id,
          statement: body(actor, id),
        }),
      ),
    ).toBe(false);
  },
};

const attachRowsTwin: ContractCase = {
  name: 'attach seals only the own delivery',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_delivery', actor, other);
    const id = ulid();
    await attempt(
      repo(context).attachBody(actor, job, {
        deliveryId: String(delivery.id),
        expectedRevision: 1,
        credentialId: id,
        statement: body(actor, id),
      }),
    );
    expect(
      await one(
        context,
        'SELECT body_credential_id FROM notification_delivery WHERE org_id = ?',
        other.orgId,
      ),
    ).toEqual({ body_credential_id: null });
  },
};

const cancelRowsTwin: ContractCase = {
  name: 'cancel changes only the own delivery',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_delivery', actor, other);
    await attempt(
      repo(context).cancel(actor, job, {
        deliveryId: String(delivery.id),
        expectedRevision: 1,
        now: LATER,
        code: 'superseded',
        event: audit('notification.delivery_cancelled', delivery, 'superseded'),
      }),
    );
    expect(
      await one(context, 'SELECT state FROM notification_delivery WHERE org_id = ?', other.orgId),
    ).toEqual({ state: 'pending' });
  },
};

function finish(delivery: Row, disable: 'credentials' | null = null) {
  return {
    deliveryId: String(delivery.id),
    expectedRevision: 1,
    now: LATER,
    code: disable ?? ('expired' as const),
    disable,
    event: audit('notification.delivery_finished', delivery, disable ?? 'expired'),
  };
}

const finishRowsTwin: ContractCase = {
  name: 'finish fails only the own delivery and counts only the own endpoint',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_delivery', actor, other);
    await twin(context, 'notification_endpoint', actor, other, { failure_streak: 4 });
    await attempt(repo(context).finish(actor, job, finish(delivery)));
    expect(
      await one(
        context,
        `SELECT d.state, e.failure_streak FROM notification_delivery d
         JOIN notification_endpoint e ON e.org_id = d.org_id AND e.id = d.endpoint_id WHERE d.org_id = ?`,
        other.orgId,
      ),
    ).toEqual({ state: 'pending', failure_streak: 4 });
  },
};

const finishSnapshotTwin: ContractCase = {
  name: 'finish counts the own snapshot revision, not a foreign twin delivery',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_delivery', actor, other, { endpoint_revision: 5 });
    await attempt(repo(context).finish(actor, job, finish(delivery)));
    expect(
      await one(
        context,
        'SELECT failure_streak FROM notification_endpoint WHERE org_id = ?',
        actor.orgId,
      ),
    ).toEqual({ failure_streak: 1 });
  },
};

const finishDisableTwin: ContractCase = {
  name: 'an immediate disable leaves a foreign twin endpoint and its waiting work alone',
  async run(context) {
    const { actor, other, delivery, job } = await armed(context);
    await twin(context, 'notification_endpoint', actor, other, { failure_streak: 8 });
    await twin(context, 'notification_delivery', actor, other, { id: '00000000-twin' });
    expect(await attempt(repo(context).finish(actor, job, finish(delivery, 'credentials')))).toBe(
      true,
    );
    expect(
      await one(
        context,
        `SELECT e.state, (SELECT state FROM notification_delivery WHERE org_id = e.org_id) AS waiting
         FROM notification_endpoint e WHERE e.org_id = ?`,
        other.orgId,
      ),
    ).toEqual({ state: 'enabled', waiting: 'pending' });
    const disabled = await one(
      context,
      "SELECT payload_json FROM audit_pending WHERE org_id = ? AND action = 'notification.auto_disable'",
      actor.orgId,
    );
    expect(JSON.parse(String(disabled?.payload_json))).toMatchObject({
      changes: { failure_streak: { new: 1 } },
    });
  },
};

const LOCATORS = {
  delivery: /prep_delivery\.org_id = \?/,
  attempt: /prep_attempt\.org_id = \?/,
  event: /prep_event\.org_id = \?/,
  endpoint: /prep_endpoint\.org_id = \?/,
  claimed: /claimed\.org_id = \?/,
  unsealed: /unsealed\.org_id = \?/,
  attach: /(?<=update notification_delivery set body_credential_id = \?[^;]*?where )org_id = \?/,
  cancel:
    /(?<=update notification_delivery set state = 'cancelled', outcome_code = \?[^;]*?where )org_id = \?/,
  finish:
    /(?<=update notification_delivery set state = 'failed', outcome_code = \?[^;]*?where )org_id = \?/,
  snapshot: /finish_snapshot\.org_id = \?/,
  count:
    /(?<=update notification_endpoint set failure_streak = failure_streak \+ 1,[^;]*?where )org_id = \?/,
  waiting:
    /(?<=update notification_delivery set state = 'cancelled', outcome_code = 'disabled'[^;]*?where )org_id = \?/,
  streak: /streak\.org_id = \?/,
};

const SHARED = [
  { locate: /job\.org_id = \?/, reason: 'jobLeaseGuard is registered by job-lease-guard.ts.' },
  {
    locate: /prep_project\.org_id = \?|prep_source\.org_id = \?|prep_ps\.org_id = \?/,
    reason:
      'project.id and source.id are primary keys and project_source is unique on (project_id, source_id), so these lookups cannot reach another organization; the comparisons are defensive.',
  },
  {
    locate: /marked\.org_id = \?/,
    reason:
      'The marker is the fresh audit id this batch writes to the disabled endpoint; no other row can carry it.',
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
        copies: 1,
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

const PREPARE = ['createNotificationPrepareRepository', 'notification-prepare'] as const;
const STREAK = ['failureStreakStatements', 'notification-settle'] as const;

export const entries: readonly MutationEntry[] = [
  entry(...PREPARE, contextTwin, LOCATORS.delivery),
  entry(...PREPARE, contextTwin, LOCATORS.attempt),
  entry(...PREPARE, contextTwin, LOCATORS.event),
  entry(...PREPARE, contextTwin, LOCATORS.endpoint),
  entry(...PREPARE, attachClaimTwin, LOCATORS.claimed),
  entry(...PREPARE, attachSealedTwin, LOCATORS.unsealed),
  entry(...PREPARE, attachRowsTwin, LOCATORS.attach),
  entry(...PREPARE, cancelRowsTwin, LOCATORS.cancel),
  entry(...PREPARE, finishRowsTwin, LOCATORS.finish),
  entry(...PREPARE, finishSnapshotTwin, LOCATORS.snapshot),
  entry(...STREAK, finishRowsTwin, LOCATORS.count),
  entry(...STREAK, finishDisableTwin, LOCATORS.waiting),
  entry(...STREAK, finishDisableTwin, LOCATORS.streak),
];
