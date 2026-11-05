import { sql } from 'kysely';
import { expect } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import type { CaptureEventInput } from '@package-broker/core/db/notifications';
import {
  notificationCaptureStatements,
  sourceOverflowStatements,
} from '../../repositories/notification-capture.js';
import { ulid } from '@package-broker/core/ids';
import {
  NOW,
  PROJECT_A,
  SOURCE,
  capturePlan,
  type FixturePlan,
  publishedEvent,
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

const MUTATED = sql<boolean>`exists (select 1 from project where id = ${PROJECT_A} and name = 'mutated')`;

async function capture(context: CaseContext, plan: FixturePlan): Promise<void> {
  await executing(context).batch([
    { sql: "UPDATE project SET name = 'mutated' WHERE id = ?", params: [PROJECT_A] },
    ...notificationCaptureStatements(orgOf(context).own, plan, MUTATED),
  ]);
}

async function count(executor: SqlExecutor, ctx: OrgContext, table: string, where = '1') {
  const [row] = await executor.all<{ n: number }>({
    sql: `SELECT count(*) AS n FROM ${table} WHERE org_id = ? AND ${where}`,
    params: [ctx.orgId],
  });
  return row!.n;
}

async function world(context: CaseContext) {
  const { own } = orgOf(context);
  await seedNotificationWorld(context.executor, own);
  return { own, foreign: orgOf(context).foreign, forged: seeder(context.executor).forged };
}

const overCap = (ctx: OrgContext) =>
  capturePlan(
    ctx,
    Array.from({ length: 65 }, (_, i) => publishedEvent({ version: `1.0.${i}` })),
  );

async function forgeEndpoint(context: CaseContext, orgId: string, id: string) {
  await seeder(context.executor).forged(
    `INSERT INTO notification_endpoint (org_id, project_id, id, name, method, events_json, package_pattern, credential_id, state, created_at, updated_at)
     VALUES (?, ?, ?, 'Foreign', 'POST', '["npm.package.published"]', '*', 'C-foreign', 'enabled', ?, ?)`,
    orgId,
    PROJECT_A,
    id,
    NOW,
    NOW,
  );
}

const foreignEndpointOnly: ContractCase = {
  name: 'capture ignores an enabled endpoint of another organization in the same project id',
  async run(context) {
    const { own, foreign } = await world(context);
    await forgeEndpoint(context, foreign.orgId, 'E9');
    await capture(context, capturePlan(own, [publishedEvent()]));
    await capture(context, overCap(own));
    expect(await count(context.executor, own, 'notification_event')).toBe(0);
    expect(
      await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
    ).toBe(0);
  },
};

const foreignEndpointJoin: ContractCase = {
  name: 'capture snapshots only own endpoints next to a colliding foreign endpoint',
  async run(context) {
    const { own, foreign } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await forgeEndpoint(context, foreign.orgId, 'E9');
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, own, 'notification_delivery')).toBe(1);
  },
};

const foreignAttachment: ContractCase = {
  name: "capture requires the own organization's attachment of the source",
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await context.executor.batch([
      {
        sql: 'DELETE FROM project_source WHERE org_id = ? AND project_id = ?',
        params: [own.orgId, PROJECT_A],
      },
    ]);
    await forged(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      foreign.orgId,
      PROJECT_A,
      SOURCE,
    );
    await capture(context, capturePlan(own, [publishedEvent()]));
    await capture(context, overCap(own));
    expect(await count(context.executor, own, 'notification_event')).toBe(0);
    expect(
      await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
    ).toBe(0);
  },
};

const foreignSource: ContractCase = {
  name: "capture requires the attached source to be the own organization's",
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await forged(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S-foreign', ?, 'Foreign', 'npm', 'hosted')",
      foreign.orgId,
    );
    await forged(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'S-foreign')",
      own.orgId,
      PROJECT_A,
    );
    const plan = (n: number) =>
      capturePlan(
        own,
        Array.from({ length: n }, (_, i) =>
          publishedEvent({ sourceId: 'S-foreign', version: `1.0.${i}` }),
        ),
      );
    await capture(context, plan(1));
    await capture(context, plan(65));
    expect(await count(context.executor, own, 'notification_event')).toBe(0);
    expect(
      await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
    ).toBe(0);
  },
};

async function fillForeign(context: CaseContext, table: 'event' | 'delivery') {
  const { foreign } = orgOf(context);
  const rows = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)`;
  await seeder(context.executor).forged(
    table === 'event'
      ? `${rows} INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
         SELECT ?, 'PF', 'F' || i, 'F' || i, 'npm.package.published', 'SF', 'x', '{}', '${NOW}' FROM n`
      : `${rows} INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, next_attempt_at, expires_at, created_at)
         SELECT ?, 'PF', 'F' || i, 'F' || i, 'EF', 1, 'CF', '${NOW}', '${NOW}', '${NOW}' FROM n`,
    foreign.orgId,
  );
}

function foreignCapacity(table: 'event' | 'delivery'): ContractCase {
  return {
    name: `capture counts only own ${table} capacity`,
    async run(context) {
      const { own } = await world(context);
      await seedEndpoint(context.executor, own, { id: 'E1' });
      await rowsOf(context, own.orgId, { prefix: 'H', count: 1, state: 'delivered' });
      await rowsOf(context, own.orgId, { prefix: 'O', count: 1, orphan: true });
      await fillForeign(context, table);
      await capture(context, capturePlan(own, [publishedEvent()]));
      expect(await count(context.executor, own, 'notification_event')).toBe(3);
      expect(await count(context.executor, own, 'notification_delivery')).toBe(2);
      expect(
        await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
      ).toBe(0);
    },
  };
}

const foreignEventId: ContractCase = {
  name: 'capture fans out only the own event when a foreign event shares its id',
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    const plan = capturePlan(own, [publishedEvent()]);
    await forged(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, 'npm.package.published', ?, '@acme/widget', '{}', ?)`,
      foreign.orgId,
      PROJECT_A,
      plan.firstEventId,
      plan.operationId,
      SOURCE,
      NOW,
    );
    await capture(context, plan);
    expect(await count(context.executor, own, 'notification_delivery')).toBe(1);
    expect(await count(context.executor, foreign, 'notification_delivery')).toBe(0);
  },
};

const foreignDelivery: ContractCase = {
  name: 'capture enqueues dispatch only for own deliveries',
  async run(context) {
    const { own, foreign, forged } = await world(context);
    const plan = capturePlan(own, [publishedEvent()]);
    await forged(
      `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, next_attempt_at, expires_at, created_at)
       VALUES (?, ?, 'DF', ?, 'EF', 1, 'CF', ?, ?, ?)`,
      foreign.orgId,
      PROJECT_A,
      plan.firstEventId,
      NOW,
      NOW,
      NOW,
    );
    await capture(context, plan);
    expect(
      await count(context.executor, own, 'job', "type = 'core:notification-dispatch:v1'"),
    ).toBe(0);
  },
};

const SECONDS = (offset: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', '-' || (${offset} - i) || ' seconds')`;

/**
 * `count` events of project A, each with one delivery to `endpoint` unless `orphan`; ids are
 * `<prefix>-<5 digits>` and the oldest finish first. Foreign rows are forged without foreign keys.
 */
async function rowsOf(
  context: CaseContext,
  orgId: string,
  options: {
    readonly prefix: string;
    readonly count: number;
    readonly state?: 'pending' | 'delivered';
    readonly orphan?: boolean;
    readonly endpoint?: string;
    readonly age?: number;
    readonly start?: number;
    /** Adds deliveries to existing events instead of new events. */
    readonly reuse?: boolean;
  },
) {
  const insert =
    orgId === orgOf(context).own.orgId
      ? (sql: string, ...params: (string | number | null)[]) =>
          run(context.executor, sql, ...params)
      : seeder(context.executor).forged;
  const start = options.start ?? 1;
  const age = options.age ?? 20_000;
  const series = `WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i + 1 FROM n WHERE i < ${start + options.count - 1})`;
  const id = `'${options.prefix}-' || substr('0000' || i, -5)`;
  if (!options.reuse)
    await insert(
      `${series} INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
     SELECT ?, ?, ${id}, ${id}, 'npm.package.published', 'S-hosted', 'x', '{}', ${SECONDS(age)} FROM n`,
      orgId,
      PROJECT_A,
    );
  if (options.orphan) return;
  const state = options.state ?? 'pending';
  const endpoint = options.endpoint ?? 'E1';
  await insert(
    `${series} INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision,
       configuration_credential_id, state, outcome_code, next_attempt_at, expires_at, created_at, finished_at)
     SELECT ?, ?, ${id} || '-${endpoint}', ${id}, '${endpoint}', 1, 'C-${endpoint}', '${state}', ${state === 'pending' ? 'NULL' : "'ok'"}, ?, ?, ?, ${state === 'pending' ? 'NULL' : SECONDS(age)} FROM n`,
    orgId,
    PROJECT_A,
    NOW,
    NOW,
    NOW,
  );
}

const run = async (executor: SqlExecutor, sql: string, ...params: (string | number | null)[]) => {
  await executor.batch([{ sql, params }]);
};

async function delivered(context: CaseContext, orgId: string): Promise<number> {
  const [row] = await context.executor.all<{ n: number }>({
    sql: "SELECT count(*) AS n FROM notification_delivery WHERE org_id = ? AND state = 'delivered'",
    params: [orgId],
  });
  return row!.n;
}

/**
 * 9,999 own events (one oldest delivered, one emptied, the rest pending) and 9,998 + `extra`
 * deliveries: the extra ones reach disabled E2, so they never count as recipients.
 */
async function nearlyFull(context: CaseContext, own: OrgContext, extra: 1 | 2) {
  await seedEndpoint(context.executor, own, { id: 'E1' });
  await seedEndpoint(context.executor, own, { id: 'E2', state: 'disabled' });
  await rowsOf(context, own.orgId, { prefix: 'H', count: 1, state: 'delivered', age: 30_000 });
  await rowsOf(context, own.orgId, { prefix: 'O', count: 1, orphan: true, age: 30_000 });
  await rowsOf(context, own.orgId, { prefix: 'P', count: 9_997 });
  await rowsOf(context, own.orgId, { prefix: 'P', count: extra, endpoint: 'E2', reuse: true });
}

/** The oldest delivered history and the emptied event both survive the capture. */
async function historyKept(context: CaseContext, own: OrgContext) {
  expect(await delivered(context, own.orgId)).toBe(1);
  expect(await count(context.executor, own, 'notification_event', "id = 'O-00001'")).toBe(1);
}

const recipientsForeignEndpoint: ContractCase = {
  name: 'capture reserves only own recipients next to a colliding foreign endpoint',
  async run(context) {
    const { own, foreign } = await world(context);
    await nearlyFull(context, own, 1);
    await forgeEndpoint(context, foreign.orgId, 'E9');
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, own, 'notification_delivery')).toBe(10_000);
    await historyKept(context, own);
  },
};

const recipientsForeignAttachment: ContractCase = {
  name: 'capture reserves no recipient for a project attached only in another organization',
  async run(context) {
    const { own } = await world(context);
    await nearlyFull(context, own, 1);
    await captureNextToForeignOnly(context, 'attachment');
    await historyKept(context, own);
  },
};

const recipientsForeignSource: ContractCase = {
  name: 'capture reserves no recipient for a source of another organization',
  async run(context) {
    const { own } = await world(context);
    await nearlyFull(context, own, 1);
    await captureNextToForeignOnly(context, 'source');
    await historyKept(context, own);
  },
};

type Guard = 'endpoint' | 'attachment' | 'source';

/**
 * Own endpoint E1 (unless `seeded`) plus a row of the other organization that alone would make the
 * returned event eligible: a foreign endpoint, a foreign attachment of an own source, or an own
 * attachment of a foreign source.
 */
async function foreignOnly(
  context: CaseContext,
  guard: Guard,
  seeded = false,
): Promise<CaptureEventInput> {
  const { own, foreign } = orgOf(context);
  const forged = seeder(context.executor).forged;
  if (!seeded)
    await seedEndpoint(context.executor, own, {
      id: 'E1',
      ...(guard === 'endpoint' ? { pattern: '@acme/widget' } : {}),
    });
  switch (guard) {
    case 'endpoint':
      await forgeEndpoint(context, foreign.orgId, 'E9');
      return publishedEvent({ packageKey: '@acme/gadget', packageName: '@acme/gadget' });
    case 'attachment':
      await run(
        context.executor,
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S-other', ?, 'Other', 'npm', 'hosted')",
        own.orgId,
      );
      await forged(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'S-other')",
        foreign.orgId,
        PROJECT_A,
      );
      return publishedEvent({ sourceId: 'S-other' });
    case 'source':
      await forged(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S-foreign', ?, 'Foreign', 'npm', 'hosted')",
        foreign.orgId,
      );
      await forged(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'S-foreign')",
        own.orgId,
        PROJECT_A,
      );
      return publishedEvent({ sourceId: 'S-foreign' });
  }
}

/** Captures one eligible event next to one that only a foreign row would make eligible; only the first is kept. */
async function captureNextToForeignOnly(context: CaseContext, guard: Guard, seeded = true) {
  const { own } = orgOf(context);
  const before = await count(context.executor, own, 'notification_event');
  const other = await foreignOnly(context, guard, seeded);
  await capture(context, capturePlan(own, [publishedEvent({ version: '2.0.0' }), other]));
  expect(await count(context.executor, own, 'notification_event')).toBe(before + 1);
}

/**
 * A full organization (10,000 events: one delivered, ten emptied, the rest pending) captures an
 * event only a foreign row would make eligible: nothing is pruned, admitted or reported.
 */
function fullForeignOnly(guard: Guard): ContractCase {
  return {
    name: `a full organization prunes nothing for an event only a foreign ${guard} makes eligible`,
    async run(context) {
      const { own } = await world(context);
      const event = await foreignOnly(context, guard);
      await rowsOf(context, own.orgId, { prefix: 'H', count: 1, state: 'delivered', age: 30_000 });
      await rowsOf(context, own.orgId, { prefix: 'O', count: 10, orphan: true, age: 30_000 });
      await rowsOf(context, own.orgId, { prefix: 'P', count: 9_989 });
      await capture(context, capturePlan(own, [event]));
      expect(await count(context.executor, own, 'notification_event')).toBe(10_000);
      expect(await delivered(context, own.orgId)).toBe(1);
      expect(
        await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
      ).toBe(0);
    },
  };
}

/** One slot left and nothing prunable: the eligible event takes it, the foreign-only one counts for nothing. */
function lastSlotForeignOnly(guard: Guard): ContractCase {
  return {
    name: `the last slot admits the own event next to one only a foreign ${guard} makes eligible`,
    async run(context) {
      const { own } = await world(context);
      await seedEndpoint(context.executor, own, {
        id: 'E1',
        ...(guard === 'endpoint' ? { pattern: '@acme/widget' } : {}),
      });
      await rowsOf(context, own.orgId, { prefix: 'P', count: 9_999 });
      await captureNextToForeignOnly(context, guard);
    },
  };
}

const replayForeignOperation: ContractCase = {
  name: "capture admits its operation when another organization's event carries its operation id",
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'H', count: 10_000, state: 'delivered' });
    const plan = capturePlan(own, [publishedEvent()]);
    await forged(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, ?, 'F-replay', ?, 'npm.package.published', ?, '@acme/widget', '{}', ?)`,
      foreign.orgId,
      PROJECT_A,
      plan.operationId,
      SOURCE,
      NOW,
    );
    await capture(context, plan);
    expect(await count(context.executor, own, 'notification_delivery')).toBe(10_000 - 1_279);
    expect(
      await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
    ).toBe(0);
  },
};

const pruneForeignHistory: ContractCase = {
  name: "capture prunes the own oldest history, never another organization's older one",
  async run(context) {
    const { own, foreign } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'H', count: 10_000, state: 'delivered' });
    await rowsOf(context, foreign.orgId, {
      prefix: 'F',
      count: 1_280,
      state: 'delivered',
      age: 40_000,
    });
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, own, 'notification_delivery')).toBe(10_000 - 1_279);
    expect(await count(context.executor, foreign, 'notification_delivery')).toBe(1_280);
  },
};

const pruneTwinHistory: ContractCase = {
  name: 'capture prune leaves foreign rows that share the pruned ids',
  async run(context) {
    const { own, foreign } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'H', count: 10_000, state: 'delivered' });
    await rowsOf(context, foreign.orgId, { prefix: 'H', count: 1_280, state: 'delivered' });
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, foreign, 'notification_delivery')).toBe(1_280);
    expect(await count(context.executor, foreign, 'notification_event')).toBe(1_280);
  },
};

const pruneForeignEvents: ContractCase = {
  name: "capture prunes the own emptied events, never another organization's",
  async run(context) {
    const { own, foreign } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'O', count: 10, orphan: true });
    await rowsOf(context, own.orgId, { prefix: 'P', count: 9_990, start: 11 });
    await rowsOf(context, foreign.orgId, { prefix: 'F', count: 1_280, orphan: true, age: 40_000 });
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, own, 'notification_event')).toBe(9_991);
    expect(await count(context.executor, foreign, 'notification_event')).toBe(1_280);
  },
};

const pruneTwinEvents: ContractCase = {
  name: 'capture event prune leaves foreign events that share the pruned ids',
  async run(context) {
    const { own, foreign } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'O', count: 10, orphan: true });
    await rowsOf(context, own.orgId, { prefix: 'P', count: 9_990, start: 11 });
    await rowsOf(context, foreign.orgId, { prefix: 'O', count: 10, orphan: true });
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, foreign, 'notification_event')).toBe(10);
  },
};

const pruneForeignReference: ContractCase = {
  name: 'an own emptied event is pruned even when a foreign delivery names its id',
  async run(context) {
    const { own, foreign } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'O', count: 10, orphan: true });
    await rowsOf(context, own.orgId, { prefix: 'P', count: 9_990, start: 11 });
    await rowsOf(context, foreign.orgId, { prefix: 'O', count: 10 });
    await capture(context, capturePlan(own, [publishedEvent()]));
    expect(await count(context.executor, own, 'notification_event')).toBe(9_991);
    expect(await count(context.executor, foreign, 'notification_event')).toBe(10);
  },
};

const overflowForeignKept: ContractCase = {
  name: 'capture records its overflow even when a foreign event shares its id',
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await rowsOf(context, own.orgId, { prefix: 'P', count: 10_000 });
    const plan = capturePlan(own, [publishedEvent()]);
    await forged(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, 'npm.package.published', ?, '@acme/widget', '{}', ?)`,
      foreign.orgId,
      PROJECT_A,
      plan.firstEventId,
      plan.operationId,
      SOURCE,
      NOW,
    );
    await capture(context, plan);
    expect(
      await count(context.executor, own, 'audit_pending', "action = 'notification.overflow'"),
    ).toBe(1);
  },
};

const FILE = 'repositories/notification-capture.ts';
const BUILDER = 'notificationCaptureStatements';

const LOCATORS = {
  ep: /cap_ep\.org_id = \?/,
  project: /cap_project\.org_id = \?/,
  ps: /cap_ps\.org_id = \?/,
  source: /cap_source\.org_id = \?/,
  events: /cap_events\.org_id = \?/,
  deliveries: /cap_deliveries\.org_id = \?/,
  endpoint: /cap_endpoint\.org_id = \?/,
  event: /cap_event\.org_id = \?/,
  fresh: /cap_fresh\.org_id = \?/,
  delivery: /cap_delivery\.org_id = \?/,
  needEp: /cap_need_ep\.org_id = \?/,
  needProject: /cap_need_project\.org_id = \?/,
  needPs: /cap_need_ps\.org_id = \?/,
  needSource: /cap_need_source\.org_id = \?/,
  oldDelivery: /cap_old_delivery\.org_id = \?/,
  oldEvent: /cap_old_event\.org_id = \?/,
  oldRef: /cap_old_ref\.org_id = \?/,
  pruneDelivery: /(?<=delete from notification_delivery where )org_id = \?/,
  pruneEvent: /(?<=delete from notification_event where )org_id = \?/,
  kept: /cap_kept\.org_id = \?/,
  replay: /cap_replay\.org_id = \?/,
};

const waivers = [
  {
    locate: LOCATORS.project,
    reason:
      'project.id is the primary key, so the join on cap_ep.project_id cannot reach another organization; the comparison is defensive.',
  },
  {
    locate: LOCATORS.needProject,
    reason:
      'project.id is the primary key, so the join on cap_need_ep.project_id cannot reach another organization; the comparison is defensive.',
  },
  {
    locate:
      /(?<=FROM project WHERE id = \? AND )org_id = \?|(?<=from project where id = \? and )org_id = \?/i,
    reason: 'The dispatch job insert is registered by job-factory.ts.',
  },
];

/** Per capture: the two prune deletes, the event insert's room check, its row filter, the overflow. */
const TWO_CAPTURES = {
  0: 'Registered by the full-organization entry: the in-capacity capture has room either way.',
  1: 'Registered by the full-organization entry: the in-capacity capture has room either way.',
  2: 'Registered by the last-slot entry: the row filter refuses every event the room check would count.',
  5: 'The over-cap capture cannot fit, so its delivery prune is unreachable.',
  6: 'The over-cap capture cannot fit, so its event prune is unreachable.',
  7: 'The over-cap capture cannot fit, so its room check is unreachable.',
  8: 'The over-cap capture cannot fit, so its row filter is unreachable.',
};

const FULL = {
  2: 'Registered by the last-slot entry: the row filter refuses every event the room check would count.',
};

const LAST_SLOT = {
  0: 'Registered by the full-organization entry: nothing here is prunable.',
  1: 'Registered by the full-organization entry: nothing here is prunable.',
  4: 'The own event is kept, so the overflow is unreachable; registered by the full-organization entry.',
};

function entry(
  contractCase: ContractCase,
  locate: RegExp,
  copies: number,
  waivedCopies?: Readonly<Record<number, string>>,
): MutationEntry {
  return {
    file: FILE,
    builder: BUILDER,
    cases: [contractCase],
    predicates: [
      {
        name: contractCase.name,
        caseName: contractCase.name,
        locate,
        neutral: '(? is not null)',
        copies,
        ...(waivedCopies === undefined ? {} : { waivedCopies }),
      },
    ],
    waivers: [
      ...waivers,
      ...Object.values(LOCATORS)
        .filter(
          (other) =>
            other.source !== locate.source &&
            other !== LOCATORS.project &&
            other !== LOCATORS.needProject,
        )
        .map((other) => ({
          locate: other,
          reason: 'Registered by another entry of this builder.',
        })),
    ],
  };
}

const GUARDS = { endpoint: LOCATORS.ep, attachment: LOCATORS.ps, source: LOCATORS.source };

export const entries: readonly MutationEntry[] = [
  entry(foreignEndpointOnly, LOCATORS.ep, 10, TWO_CAPTURES),
  entry(foreignAttachment, LOCATORS.ps, 10, TWO_CAPTURES),
  entry(foreignSource, LOCATORS.source, 10, TWO_CAPTURES),
  ...(Object.entries(GUARDS) as [Guard, RegExp][]).flatMap(([guard, locate]) => [
    entry(fullForeignOnly(guard), locate, 5, FULL),
    entry(lastSlotForeignOnly(guard), locate, 5, LAST_SLOT),
  ]),
  entry(foreignCapacity('event'), LOCATORS.events, 3),
  entry(foreignCapacity('delivery'), LOCATORS.deliveries, 3),
  entry(recipientsForeignEndpoint, LOCATORS.needEp, 3),
  entry(recipientsForeignAttachment, LOCATORS.needPs, 3),
  entry(recipientsForeignSource, LOCATORS.needSource, 3),
  entry(replayForeignOperation, LOCATORS.replay, 3),
  entry(pruneForeignHistory, LOCATORS.oldDelivery, 1),
  entry(pruneTwinHistory, LOCATORS.pruneDelivery, 1),
  entry(pruneForeignEvents, LOCATORS.oldEvent, 1),
  entry(pruneTwinEvents, LOCATORS.pruneEvent, 1),
  entry(pruneForeignReference, LOCATORS.oldRef, 1),
  entry(overflowForeignKept, LOCATORS.kept, 1),
  entry(foreignEndpointJoin, LOCATORS.endpoint, 1),
  entry(foreignEventId, LOCATORS.event, 1),
  entry(foreignEventId, LOCATORS.fresh, 1),
  entry(foreignDelivery, LOCATORS.delivery, 1),
];

async function sourceOverflow(context: CaseContext, sourceId = SOURCE): Promise<number> {
  const { own } = orgOf(context);
  await executing(context).batch([
    { sql: "UPDATE project SET name = 'mutated' WHERE id = ?", params: [PROJECT_A] },
    ...sourceOverflowStatements(
      own,
      {
        operationId: ulid(),
        occurredAt: NOW,
        sourceId,
        packageKey: '@acme/widget',
        eventTypes: ['npm.package.published'],
        eventCount: 130,
      },
      MUTATED,
    ),
  ]);
  return count(context.executor, own, 'audit_pending', "action = 'notification.overflow'");
}

const overflowForeignEndpoint: ContractCase = {
  name: 'a source overflow ignores an enabled endpoint of another organization',
  async run(context) {
    const { foreign } = await world(context);
    await forgeEndpoint(context, foreign.orgId, 'E9');
    expect(await sourceOverflow(context)).toBe(0);
  },
};

const overflowForeignAttachment: ContractCase = {
  name: "a source overflow requires the own organization's attachment of the source",
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await context.executor.batch([
      { sql: 'DELETE FROM project_source WHERE org_id = ?', params: [own.orgId] },
    ]);
    await forged(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      foreign.orgId,
      PROJECT_A,
      SOURCE,
    );
    expect(await sourceOverflow(context)).toBe(0);
  },
};

const overflowForeignSource: ContractCase = {
  name: "a source overflow requires the source to be the own organization's",
  async run(context) {
    const { own, foreign, forged } = await world(context);
    await seedEndpoint(context.executor, own, { id: 'E1' });
    await forged(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S-foreign', ?, 'Foreign', 'npm', 'hosted')",
      foreign.orgId,
    );
    await forged(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'S-foreign')",
      own.orgId,
      PROJECT_A,
    );
    expect(await sourceOverflow(context, 'S-foreign')).toBe(0);
  },
};

const OVERFLOW_LOCATORS = {
  ep: /over_ep\.org_id = \?/,
  project: /over_project\.org_id = \?/,
  ps: /over_ps\.org_id = \?/,
  source: /over_source\.org_id = \?/,
};

function overflowEntry(contractCase: ContractCase, locate: RegExp): MutationEntry {
  return {
    file: FILE,
    builder: 'sourceOverflowStatements',
    cases: [contractCase],
    predicates: [
      {
        name: contractCase.name,
        caseName: contractCase.name,
        locate,
        neutral: '(? is not null)',
        copies: 1,
      },
    ],
    waivers: [
      {
        locate: OVERFLOW_LOCATORS.project,
        reason:
          'project.id is the primary key, so the join on over_ep.project_id cannot reach another organization; the comparison is defensive.',
      },
      ...Object.values(OVERFLOW_LOCATORS)
        .filter((other) => other.source !== locate.source && other !== OVERFLOW_LOCATORS.project)
        .map((other) => ({
          locate: other,
          reason: 'Registered by another entry of this builder.',
        })),
    ],
  };
}

export const overflowEntries: readonly MutationEntry[] = [
  overflowEntry(overflowForeignEndpoint, OVERFLOW_LOCATORS.ep),
  overflowEntry(overflowForeignAttachment, OVERFLOW_LOCATORS.ps),
  overflowEntry(overflowForeignSource, OVERFLOW_LOCATORS.source),
];
