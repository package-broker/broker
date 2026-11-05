import { sql } from 'kysely';
import { expect } from 'vitest';
import { deliverIdempotencyKey } from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { notificationCaptureStatements } from '../../repositories/notification-capture.js';
import { createNotificationDispatchRepository } from '../../repositories/notification-dispatch.js';
import {
  NOW,
  PROJECT_A,
  SOURCE,
  capturePlan,
  publishedEvent,
  rows,
  run,
  seedEndpoint,
  seedNotificationWorld,
} from '../../contract/notification-fixture.js';
import { executing } from './factory-cases.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';

export const ENDPOINT_IDS = Array.from({ length: 6 }, (_, i) => `01J0EEEEEEEEEEEEEEEEEEEEE${i}`);
const LEASE = { id: 'dispatch-job', owner: 'owner', fence: 1 };

export async function leaseJob(executor: SqlExecutor, ctx: OrgContext, id: string, fence = 1) {
  await run(
    executor,
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES (?, ?, 'test:v1', ?, 'running', 'owner', '2099-01-01T00:00:00.000Z', ?)
     ON CONFLICT (id) DO UPDATE SET state = 'running', lease_owner = 'owner',
       lease_until = '2099-01-01T00:00:00.000Z', fence = excluded.fence`,
    id,
    ctx.orgId,
    `lease:${id}`,
    fence,
  );
  return { id, owner: 'owner', fence };
}

/** Own world, endpoints and one captured operation per entry of `operations`. */
export async function captured(
  context: CaseContext,
  endpoints: number,
  operations = 1,
  swapped = false,
) {
  const orgs = orgOf(context);
  const [own, foreign] = swapped ? [orgs.foreign, orgs.own] : [orgs.own, orgs.foreign];
  await seedNotificationWorld(context.executor, own);
  for (const id of ENDPOINT_IDS.slice(0, endpoints))
    await seedEndpoint(context.executor, own, { id });
  const plans = [];
  for (let i = 0; i < operations; i += 1) {
    const plan = capturePlan(own, [publishedEvent({ version: `1.0.${i}` })]);
    await context.executor.batch(notificationCaptureStatements(own, plan, sql<boolean>`1`));
    plans.push(plan);
  }
  await leaseJob(context.executor, own, LEASE.id);
  return { own, foreign, plans, forged: seeder(context.executor).forged };
}

export async function forgeDelivery(
  context: CaseContext,
  orgId: string,
  id: string,
  eventId: string,
  activeJobId: string | null = null,
) {
  await seeder(context.executor).forged(
    `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, active_job_id, next_attempt_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'CF', ?, ?, '2026-11-02T12:00:00.000Z', ?)`,
    orgId,
    PROJECT_A,
    id,
    eventId,
    `EF-${id}`,
    activeJobId,
    NOW,
    NOW,
  );
}

export async function forgeEvent(
  context: CaseContext,
  orgId: string,
  id: string,
  operationId: string,
) {
  await seeder(context.executor).forged(
    `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, 'npm.package.published', ?, '@acme/widget', '{}', ?)`,
    orgId,
    PROJECT_A,
    id,
    operationId,
    SOURCE,
    NOW,
  );
}

async function ownDeliveries(executor: SqlExecutor, ctx: OrgContext) {
  return rows<{ id: string; event_id: string; active_job_id: string | null }>(
    executor,
    'SELECT id, event_id, active_job_id FROM notification_delivery WHERE org_id = ? ORDER BY id',
    ctx.orgId,
  );
}

const page = (context: CaseContext, ctx: OrgContext, operationId: string) =>
  createNotificationDispatchRepository(executing(context))
    .dispatchPage(ctx, LEASE, operationId)
    .catch(() => 'error' as const);

const foreignRecipients: ContractCase = {
  name: 'dispatch pages only own recipients of own events next to colliding foreign rows',
  async run(context) {
    const { own, foreign, plans, forged } = await captured(context, 5);
    const [delivery] = await ownDeliveries(context.executor, own);
    await forged(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, 'npm.package.published', ?, '@acme/widget', '{}', ?)`,
      foreign.orgId,
      PROJECT_A,
      delivery!.event_id,
      plans[0]!.operationId,
      SOURCE,
      NOW,
    );
    for (let i = 0; i < 5; i += 1)
      await forgeDelivery(context, foreign.orgId, `00000000-${i}`, delivery!.event_id);
    const result = await page(context, own, plans[0]!.operationId);
    expect(result === 'error' ? result : result.jobIds.length).toBe(5);
  },
};

const raceScheduled: ContractCase = {
  name: 'dispatch enqueues no job for an own delivery scheduled since the page was read',
  async run(context) {
    const { own, foreign, plans } = await captured(context, 1);
    const [delivery] = await ownDeliveries(context.executor, own);
    await forgeDelivery(context, foreign.orgId, delivery!.id, delivery!.event_id);
    const base = executing(context);
    const racing: SqlExecutor = {
      driver: base.driver,
      all: async (statement) => {
        const result = await base.all(statement);
        await context.executor.batch([
          {
            sql: "UPDATE notification_delivery SET active_job_id = 'elsewhere' WHERE org_id = ?",
            params: [own.orgId],
          },
        ]);
        return result as never;
      },
      batch: (statements) => base.batch(statements),
    };
    await createNotificationDispatchRepository(racing)
      .dispatchPage(own, LEASE, plans[0]!.operationId)
      .catch(() => undefined);
    expect(
      await rows(
        context.executor,
        "SELECT count(*) AS n FROM job WHERE org_id = ? AND type = 'core:notification-deliver:v1'",
        own.orgId,
      ),
    ).toEqual([{ n: 0 }]);
  },
};

const foreignTwin: ContractCase = {
  name: 'dispatch records and reports only the own delivery job next to a foreign twin',
  async run(context) {
    const { own, foreign, plans, forged } = await captured(context, 1);
    const [delivery] = await ownDeliveries(context.executor, own);
    await forgeDelivery(context, foreign.orgId, delivery!.id, delivery!.event_id, 'FOREIGN-JOB');
    await forged(
      `INSERT INTO job (id, org_id, type, idempotency_key, state) VALUES ('FOREIGN-KEYED', ?, 'core:notification-deliver:v1', ?, 'queued')`,
      foreign.orgId,
      deliverIdempotencyKey(delivery!.id, 1),
    );
    const result = await page(context, own, plans[0]!.operationId);
    const [after] = await ownDeliveries(context.executor, own);
    const [job] = await rows<{ id: string }>(
      context.executor,
      "SELECT id FROM job WHERE org_id = ? AND type = 'core:notification-deliver:v1'",
      own.orgId,
    );
    expect(after!.active_job_id).toBe(job?.id);
    expect(result === 'error' ? result : result.jobIds).toEqual([job?.id]);
    expect(
      await rows(
        context.executor,
        'SELECT active_job_id FROM notification_delivery WHERE org_id = ?',
        foreign.orgId,
      ),
    ).toEqual([{ active_job_id: 'FOREIGN-JOB' }]);
  },
};

const collidingJobKey: ContractCase = {
  name: 'dispatch records the job of its own organization when an earlier-sorting one holds the key',
  async run(context) {
    const { own, foreign, plans, forged } = await captured(context, 1, 1, true);
    const [delivery] = await ownDeliveries(context.executor, own);
    await forged(
      `INSERT INTO job (id, org_id, type, idempotency_key, state) VALUES ('FOREIGN-KEYED', ?, 'core:notification-deliver:v1', ?, 'queued')`,
      foreign.orgId,
      deliverIdempotencyKey(delivery!.id, 1),
    );
    await page(context, own, plans[0]!.operationId);
    const [after] = await ownDeliveries(context.executor, own);
    expect(after!.active_job_id).not.toBe('FOREIGN-KEYED');
    expect(after!.active_job_id).not.toBeNull();
  },
};

const foreignUnscheduledTwin: ContractCase = {
  name: 'dispatch schedules only the own delivery when a foreign twin is unscheduled too',
  async run(context) {
    const { own, foreign, plans } = await captured(context, 1);
    const [delivery] = await ownDeliveries(context.executor, own);
    await forgeDelivery(context, foreign.orgId, delivery!.id, delivery!.event_id);
    await page(context, own, plans[0]!.operationId);
    expect(
      await rows(
        context.executor,
        'SELECT active_job_id FROM notification_delivery WHERE org_id = ?',
        foreign.orgId,
      ),
    ).toEqual([{ active_job_id: null }]);
  },
};

const foreignOperation: ContractCase = {
  name: 'dispatch marks and counts only own events of the operation',
  async run(context) {
    const { own, foreign, plans } = await captured(context, 1);
    await forgeEvent(context, foreign.orgId, 'FOREIGN-EVENT', plans[0]!.operationId);
    const result = await page(context, own, plans[0]!.operationId);
    expect(result === 'error' ? result : result.done).toBe(true);
    expect(
      await rows(
        context.executor,
        'SELECT dispatched_at FROM notification_event WHERE org_id = ?',
        foreign.orgId,
      ),
    ).toEqual([{ dispatched_at: null }]);
  },
};

const foreignRemaining: ContractCase = {
  name: "dispatch completes despite another organization's unscheduled delivery of the event",
  async run(context) {
    const { own, foreign, plans } = await captured(context, 1, 2);
    const deliveries = await ownDeliveries(context.executor, own);
    const [second] = await rows<{ id: string }>(
      context.executor,
      'SELECT id FROM notification_event WHERE org_id = ? AND operation_id = ?',
      own.orgId,
      plans[1]!.operationId,
    );
    const first = deliveries.find((d) => d.event_id !== second!.id)!;
    await forgeDelivery(context, foreign.orgId, '00000000-f', first.event_id);
    await forgeEvent(context, foreign.orgId, second!.id, plans[0]!.operationId);
    const result = await page(context, own, plans[0]!.operationId);
    expect(result === 'error' ? result : result.done).toBe(true);
  },
};

const FILE = 'repositories/notification-dispatch.ts';
const BUILDER = 'createNotificationDispatchRepository';

const LOCATORS = {
  delivery: /dispatch_delivery\.org_id = \?/,
  event: /dispatch_event\.org_id = \?/,
  unscheduled: /unscheduled\.org_id = \?/,
  scheduled: /(?<!un)scheduled\.org_id = \?/,
  update: /(?<=update notification_delivery set active_job_id[^;]*?\n\s*where )org_id = \?/,
  mark: /(?<=update notification_event set dispatched_at[^;]*?where )org_id = \?/,
  remaining: /remaining\.org_id = \?/,
  remainingEvent: /remaining_event\.org_id = \?/,
  open: /open_event\.org_id = \?/,
  recorded: /recorded\.org_id = \?/,
};

const shared = [
  {
    locate: /job\.org_id = \?/,
    reason: 'jobLeaseGuard is registered by job-lease-guard.ts.',
  },
  {
    locate: /(?<=FROM project WHERE id = \? AND )org_id = \?/,
    reason: 'The delivery job insert is registered by job-factory.ts.',
  },
];

function entry(contractCase: ContractCase, locate: RegExp): MutationEntry {
  return {
    file: FILE,
    builder: BUILDER,
    cases: [contractCase],
    predicates: [
      {
        name: `${contractCase.name} (${locate.source})`,
        caseName: contractCase.name,
        locate,
        neutral: '(? is not null)',
      },
    ],
    waivers: [
      ...shared,
      ...Object.values(LOCATORS)
        .filter((other) => other.source !== locate.source)
        .map((other) => ({
          locate: other,
          reason: 'Registered by another entry of this factory.',
        })),
    ],
  };
}

export const entries: readonly MutationEntry[] = [
  entry(foreignRecipients, LOCATORS.delivery),
  entry(foreignRecipients, LOCATORS.event),
  entry(raceScheduled, LOCATORS.unscheduled),
  entry(collidingJobKey, LOCATORS.scheduled),
  entry(foreignUnscheduledTwin, LOCATORS.update),
  entry(foreignTwin, LOCATORS.recorded),
  entry(foreignOperation, LOCATORS.mark),
  entry(foreignOperation, LOCATORS.open),
  entry(foreignRemaining, LOCATORS.remaining),
  entry(foreignRemaining, LOCATORS.remainingEvent),
];
