import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createNotificationReadRepository } from '../../repositories/notification-read.js';
import { executing, factoryEntry } from './factory-cases.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';

const NOW = '2026-11-01T12:00:00.000Z';
const LATER = '2026-11-02T12:00:00.000Z';

/** Two projects per organization; notification ids collide across organizations. */
export async function seedNotificationRows(
  executor: SqlExecutor,
  orgId: string,
  suffix: string,
): Promise<void> {
  const seed = seeder(executor);
  for (const project of ['P1', 'P2']) {
    await seed(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      `${project}${suffix}`,
      orgId,
      `${project.toLowerCase()}${suffix.toLowerCase()}`,
      project,
    );
    await seed(
      "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, 'npm-notification', x'00', zeroblob(12), 1, 'aad')",
      `C-${project}${suffix}`,
      orgId,
      `${project}${suffix}`,
    );
  }
  for (const [endpoint, project] of [
    ['E1', 'P1'],
    ['E2', 'P2'],
    ['E3', 'P1'],
  ] as const) {
    await seed(
      `INSERT INTO notification_endpoint (org_id, project_id, id, name, method, events_json, package_pattern, credential_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'POST', '["npm.package.published"]', '*', ?, ?, ?)`,
      orgId,
      `${project}${suffix}`,
      endpoint,
      `${endpoint}${suffix}`,
      `C-${project}${suffix}`,
      NOW,
      NOW,
    );
  }
  for (const [event, endpoint, project] of [
    ['V1', 'E1', 'P1'],
    ['V2', 'E2', 'P2'],
  ] as const) {
    await seed(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, 'npm.package.published', 'S', 'widget', '{}', ?)`,
      orgId,
      `${project}${suffix}`,
      event,
      `O-${event}`,
      NOW,
    );
    await seed(
      `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, next_attempt_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      orgId,
      `${project}${suffix}`,
      `D${event.slice(1)}`,
      event,
      endpoint,
      `C-${project}${suffix}`,
      NOW,
      LATER,
      NOW,
    );
  }
  await seed(
    "INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at) VALUES (?, ?, 'D1', 1, 'J', 1, 'started', ?)",
    orgId,
    `P1${suffix}`,
    NOW,
  );
}

async function seedBoth(context: CaseContext): Promise<void> {
  const { own, foreign } = orgOf(context);
  await seedNotificationRows(context.executor, own.orgId, '');
  await seedNotificationRows(context.executor, foreign.orgId, 'B');
}

type Read = 'listEndpoints' | 'getEndpoint' | 'listDeliveries' | 'getDelivery';

async function read(
  context: CaseContext,
  method: Read,
  org: 'own' | 'foreign',
  projectId: string,
  endpointId = 'E1',
): Promise<unknown> {
  const repo = createNotificationReadRepository(executing(context));
  const { own, foreign } = orgOf(context);
  const ctx = org === 'own' ? own : foreign;
  switch (method) {
    case 'listEndpoints':
      return (await repo.listEndpoints(ctx, projectId, { limit: 50 })).items.map((e) => e.id);
    case 'getEndpoint':
      return (await repo.getEndpoint(ctx, projectId, endpointId))?.id ?? null;
    case 'listDeliveries':
      return (await repo.listDeliveries(ctx, projectId, endpointId, { limit: 50 })).items.map(
        (d) => d.id,
      );
    case 'getDelivery':
      return (await repo.getDelivery(ctx, projectId, endpointId, 'D1'))?.id ?? null;
  }
}

function empty(method: Read): unknown {
  return method === 'getEndpoint' || method === 'getDelivery' ? null : [];
}

function foreignOrganization(method: Read): ContractCase {
  return {
    name: `${method} hides another organization's colliding notification rows`,
    async run(context) {
      await seedBoth(context);
      expect(await read(context, method, 'foreign', 'P1')).toEqual(empty(method));
    },
  };
}

function foreignProject(method: Read): ContractCase {
  return {
    name: `${method} hides a sibling project's notification rows`,
    async run(context) {
      await seedBoth(context);
      if (method === 'listEndpoints') {
        expect(await read(context, method, 'own', 'P2')).toEqual(['E2']);
        return;
      }
      expect(await read(context, method, 'own', 'P2')).toEqual(empty(method));
    },
  };
}

function otherEndpoint(method: 'listDeliveries' | 'getDelivery'): ContractCase {
  return {
    name: `${method} hides deliveries of another endpoint in the project`,
    async run(context) {
      await seedBoth(context);
      expect(await read(context, method, 'own', 'P1', 'E3')).toEqual(empty(method));
    },
  };
}

function missingEndpoint(org: 'own' | 'foreign', projectId: string, name: string): ContractCase {
  return {
    name,
    async run(context) {
      await seedBoth(context);
      await expect(read(context, 'listDeliveries', org, projectId)).rejects.toMatchObject({
        code: 'not_found',
      });
    },
  };
}

const foreignEndpointHistory = missingEndpoint(
  'foreign',
  'P1',
  "listDeliveries refuses another organization's endpoint",
);
const siblingEndpointHistory = missingEndpoint(
  'own',
  'P2',
  "listDeliveries refuses a sibling project's endpoint",
);

const forgedForeignDelivery: ContractCase = {
  name: "listDeliveries hides another organization's forged delivery in the own project",
  async run(context) {
    await seedBoth(context);
    const { foreign } = orgOf(context);
    const seed = seeder(context.executor).forged;
    await seed(
      `INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at)
       VALUES (?, 'P1', 'V9', 'O-V9', 'npm.package.published', 'S', 'widget', '{}', ?)`,
      foreign.orgId,
      NOW,
    );
    await seed(
      `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, next_attempt_at, expires_at, created_at)
       VALUES (?, 'P1', 'D9', 'V9', 'E1', 1, 'C-P1B', ?, ?, ?)`,
      foreign.orgId,
      NOW,
      LATER,
      NOW,
    );
    expect(await read(context, 'listDeliveries', 'own', 'P1')).toEqual(['D1']);
  },
};

const forgedSiblingDelivery: ContractCase = {
  name: "listDeliveries hides a sibling project's forged delivery for the endpoint",
  async run(context) {
    await seedBoth(context);
    const { own } = orgOf(context);
    await seeder(context.executor).forged(
      `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, next_attempt_at, expires_at, created_at)
       VALUES (?, 'P2', 'D9', 'V2', 'E1', 1, 'C-P2', ?, ?, ?)`,
      own.orgId,
      NOW,
      LATER,
      NOW,
    );
    expect(await read(context, 'listDeliveries', 'own', 'P1')).toEqual(['D1']);
  },
};

const forgedAttempt: ContractCase = {
  name: 'getDelivery history excludes a forged attempt of another organization',
  async run(context) {
    await seedBoth(context);
    const { own, foreign } = orgOf(context);
    await seeder(context.executor).forged(
      "INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at) VALUES (?, 'P1', 'D1', 2, 'J', 1, 'started', ?)",
      foreign.orgId,
      NOW,
    );
    const detail = await createNotificationReadRepository(executing(context)).getDelivery(
      own,
      'P1',
      'E1',
      'D1',
    );
    expect(detail?.history.map((attempt) => attempt.attempt)).toEqual([1]);
  },
};

const forgedProjectAttempt: ContractCase = {
  name: 'getDelivery history excludes a forged attempt of a sibling project',
  async run(context) {
    await seedBoth(context);
    const { own } = orgOf(context);
    await seeder(context.executor).forged(
      "INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at) VALUES (?, 'P2', 'D1', 2, 'J', 1, 'started', ?)",
      own.orgId,
      NOW,
    );
    const detail = await createNotificationReadRepository(executing(context)).getDelivery(
      own,
      'P1',
      'E1',
      'D1',
    );
    expect(detail?.history.map((attempt) => attempt.attempt)).toEqual([1]);
  },
};

const FILE = 'notification-read';
const BUILDER = 'createNotificationReadRepository';
const joinWaiver = {
  locate: /"nv"\."org_id" = "nd"\."org_id"/,
  reason: 'Composite organization join equality; the nd organization predicate scopes the event.',
};
const deliveryWaiver = {
  locate: /"nd"\."org_id" = \?/,
  reason: 'Registered by the delivery organization entries of this factory.',
};
const attemptWaiver = {
  locate: /"na"\."org_id" = \?/,
  reason: 'Registered by the forged attempt entry of this factory.',
};
const historyEndpointOrganization = /(?<=from "notification_endpoint" where )"org_id" = \?/;
const historyEndpointProject =
  /(?<=from "notification_endpoint" where "org_id" = \? and )"project_id" = \?/;
const historyEndpointWaiver = {
  locate: historyEndpointOrganization,
  reason: 'Registered by the history endpoint organization entry.',
};

export const entries: readonly MutationEntry[] = [
  ...(['listEndpoints', 'getEndpoint'] as const).flatMap((method) => [
    factoryEntry(FILE, BUILDER, foreignOrganization(method), /"ne"\."org_id" = \?/),
    factoryEntry(FILE, BUILDER, foreignProject(method), /"ne"\."project_id" = \?/, [
      { locate: /"ne"\."org_id" = \?/, reason: 'Registered by the organization entry.' },
    ]),
  ]),
  factoryEntry(FILE, BUILDER, foreignOrganization('getDelivery'), /"nd"\."org_id" = \?/, [
    joinWaiver,
    attemptWaiver,
  ]),
  factoryEntry(FILE, BUILDER, foreignProject('getDelivery'), /"nd"\."project_id" = \?/, [
    joinWaiver,
    attemptWaiver,
    deliveryWaiver,
  ]),
  ...(['listDeliveries', 'getDelivery'] as const).map((method) =>
    factoryEntry(
      FILE,
      BUILDER,
      otherEndpoint(method),
      /"nd"\."endpoint_id" = \?/,
      method === 'getDelivery'
        ? [joinWaiver, attemptWaiver, deliveryWaiver]
        : [joinWaiver, deliveryWaiver, historyEndpointWaiver],
    ),
  ),
  factoryEntry(FILE, BUILDER, foreignEndpointHistory, historyEndpointOrganization),
  factoryEntry(FILE, BUILDER, siblingEndpointHistory, historyEndpointProject, [
    historyEndpointWaiver,
  ]),
  factoryEntry(FILE, BUILDER, forgedForeignDelivery, /"nd"\."org_id" = \?/, [
    joinWaiver,
    historyEndpointWaiver,
  ]),
  factoryEntry(FILE, BUILDER, forgedSiblingDelivery, /"nd"\."project_id" = \?/, [
    joinWaiver,
    deliveryWaiver,
    historyEndpointWaiver,
  ]),
  factoryEntry(FILE, BUILDER, forgedAttempt, /"na"\."org_id" = \?/, [joinWaiver, deliveryWaiver]),
  factoryEntry(FILE, BUILDER, forgedProjectAttempt, /"na"\."project_id" = \?/, [
    joinWaiver,
    deliveryWaiver,
    attemptWaiver,
  ]),
];
