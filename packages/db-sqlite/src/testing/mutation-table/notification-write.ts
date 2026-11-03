import { expect } from 'vitest';
import { auditEvent, type AuditAction, type AuditEvent } from '@package-broker/core/audit/actions';
import type { MutationFence } from '@package-broker/core/authz/fence';
import type {
  NotificationEndpointTransition,
  NotificationSealedConfiguration,
  NotificationWriteRepository,
  NotificationWriteResult,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import { createCredentialRepository } from '../../repositories/credential.js';
import { createNotificationWriteRepository } from '../../repositories/notification-write.js';
import { ANCHORS, fenceOf, seedBindings, seedProject, seedSubject } from './fixtures.js';
import { executing } from './factory-cases.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
  type OrgWaiver,
} from './harness.js';

export const OPTIONS = {
  name: 'Release hook',
  method: 'POST',
  events: ['npm.package.published'],
  packagePattern: '@acme/*',
} as const;

export interface NotificationWriter {
  readonly org: OrgContext;
  readonly fence: MutationFence;
  readonly repo: NotificationWriteRepository;
  /** Unmutated, for arranging state before the write under test. */
  readonly setup: NotificationWriteRepository;
  readonly userId: string;
  sealed(projectId?: string): NotificationSealedConfiguration;
  event(action: AuditAction, endpointId: string, projectId?: string): AuditEvent;
  create(
    endpointId: string,
    projectId?: string,
    via?: 'setup' | 'repo',
  ): ReturnType<NotificationWriteRepository['create']>;
  row(orgId: string, endpointId: string): Promise<Record<string, unknown> | undefined>;
}

/** An own-organization project owner with `project:settings:write` on P1 and a fresh reauthentication. */
export async function notificationWriter(
  context: CaseContext,
  executor: SqlExecutor = executing(context),
): Promise<NotificationWriter> {
  const { own } = orgOf(context);
  const seed = seeder(context.executor);
  await seedBindings(context);
  for (const project of ['P1', 'P2']) await seedProject(seed, project, own.orgId);
  const owner = await seedSubject(context, 'owner', { projectId: 'P1' });
  await seed(
    "UPDATE role_permission SET permission = 'project:settings:write' WHERE role_id = 'R-owner'",
  );
  await seed(
    "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    owner.sessionId,
  );
  const credentials = createCredentialRepository(context.executor);
  const repo = createNotificationWriteRepository(executor, ANCHORS);
  const setup = createNotificationWriteRepository(context.executor, ANCHORS);
  const fence = fenceOf(owner);
  const writer: NotificationWriter = {
    org: own,
    fence,
    repo,
    setup,
    userId: owner.userId,
    sealed(projectId = 'P1') {
      const id = ulid();
      return {
        credentialId: id,
        statement: credentials.insertStatement(own, {
          id,
          projectId,
          kind: 'npm-notification',
          sealed: { ciphertext: new Uint8Array([1]), nonce: new Uint8Array(12), keyVersion: 1 },
          aad: credentialAad({ id, orgId: own.orgId, kind: 'npm-notification' }),
          rotatedAt: null,
          now: new Date().toISOString(),
        }),
        headersConfigured: false,
        templateConfigured: false,
      };
    },
    event(action, endpointId, projectId = 'P1') {
      const result = auditEvent({
        id: ulid(),
        now: new Date().toISOString(),
        action,
        actor: { type: 'user', id: owner.userId },
        context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        target: { type: 'notification_endpoint', id: endpointId },
        projectId,
      });
      if (!result.ok) throw new Error(result.reason);
      return result.event;
    },
    create(endpointId, projectId = 'P1', via = 'setup') {
      return (via === 'setup' ? setup : repo).create(own, fence, {
        id: endpointId,
        projectId,
        now: new Date().toISOString(),
        options: OPTIONS,
        configuration: writer.sealed(projectId),
        event: writer.event('notification.create', endpointId, projectId),
      });
    },
    async row(orgId, endpointId) {
      const [row] = await context.executor.all<Record<string, unknown>>({
        sql: 'SELECT state, revision, disabled_reason, failure_streak FROM notification_endpoint WHERE org_id = ? AND id = ?',
        params: [orgId, endpointId],
      });
      return row;
    },
  };
  return writer;
}

/** A colliding endpoint row of the foreign organization in the own project id. */
async function forgeForeign(context: CaseContext, id: string, state: string, revision = 1) {
  const { foreign } = orgOf(context);
  const seed = seeder(context.executor).forged;
  await seed(
    "INSERT OR IGNORE INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES ('FC', ?, 'P1', 'npm-notification', x'00', zeroblob(12), 1, 'aad')",
    foreign.orgId,
  );
  await seed(
    `INSERT INTO notification_endpoint (org_id, project_id, id, name, method, events_json, package_pattern, credential_id, state, revision, created_at, updated_at)
     VALUES (?, 'P1', ?, 'Foreign', 'POST', '["npm.package.published"]', '*', 'FC', ?, ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    foreign.orgId,
    id,
    state,
    revision,
  );
}

type Transition = 'enable' | 'disable' | 'delete';

export function transition(
  repo: NotificationWriteRepository,
  kind: Transition,
  writer: Pick<NotificationWriter, 'org' | 'fence'>,
  input: NotificationEndpointTransition,
): Promise<NotificationWriteResult> {
  switch (kind) {
    case 'enable':
      return repo.enable(writer.org, writer.fence, input);
    case 'disable':
      return repo.disable(writer.org, writer.fence, input);
    case 'delete':
      return repo.delete(writer.org, writer.fence, input);
  }
}

function from(kind: Transition): string {
  return kind === 'enable' ? 'disabled' : 'enabled';
}

async function settled<T>(promise: Promise<T>): Promise<T | { readonly error: unknown }> {
  return promise.catch((error: unknown) => ({ error: (error as { code?: unknown }).code }));
}

function foreignTarget(kind: Transition): ContractCase {
  return {
    name: `${kind} changes only the own organization's colliding endpoint`,
    async run(context) {
      const writer = await notificationWriter(context);
      await writer.create('E1');
      if (kind !== 'enable')
        await writer.setup.enable(writer.org, writer.fence, {
          id: 'E1',
          projectId: 'P1',
          expectedRevision: 1,
          now: new Date().toISOString(),
          event: writer.event('notification.enable', 'E1'),
        });
      const revision = kind === 'enable' ? 1 : 2;
      await forgeForeign(context, 'E1', from(kind), revision);
      const result = await settled(
        transition(writer.repo, kind, writer, {
          id: 'E1',
          projectId: 'P1',
          expectedRevision: revision,
          now: new Date().toISOString(),
          event: writer.event(`notification.${kind}`, 'E1'),
        }),
      );
      expect(result).toEqual({ changed: true, revision: revision + 1 });
      expect(await writer.row(orgOf(context).foreign.orgId, 'E1')).toMatchObject({
        state: from(kind),
        revision,
      });
    },
  };
}

function foreignRevision(kind: Transition): ContractCase {
  return {
    name: `${kind} refuses a stale own revision that a foreign endpoint would satisfy`,
    async run(context) {
      const writer = await notificationWriter(context);
      await writer.create('E1');
      await writer.setup.update(writer.org, writer.fence, {
        id: 'E1',
        projectId: 'P1',
        expectedRevision: 1,
        now: new Date().toISOString(),
        options: { ...OPTIONS, name: 'Renamed' },
        event: writer.event('notification.update', 'E1'),
      });
      await seeder(context.executor)(
        "UPDATE notification_endpoint SET state = ? WHERE org_id = ? AND id = 'E1'",
        from(kind),
        writer.org.orgId,
      );
      await forgeForeign(context, 'E1', from(kind), 1);
      const result = await settled(
        transition(writer.repo, kind, writer, {
          id: 'E1',
          projectId: 'P1',
          expectedRevision: 1,
          now: new Date().toISOString(),
          event: writer.event(`notification.${kind}`, 'E1'),
        }),
      );
      expect(result).toEqual({ changed: false, revision: 2 });
    },
  };
}

const foreignLookup: ContractCase = {
  name: 'a refused transition reports a missing own endpoint even when a foreign one collides',
  async run(context) {
    const writer = await notificationWriter(context);
    await forgeForeign(context, 'E1', 'disabled');
    const result = await settled(
      writer.repo.enable(writer.org, writer.fence, {
        id: 'E1',
        projectId: 'P1',
        expectedRevision: 1,
        now: new Date().toISOString(),
        event: writer.event('notification.enable', 'E1'),
      }),
    );
    expect(result).toEqual({ error: 'not_found' });
  },
};

const foreignCap: ContractCase = {
  name: 'create counts only the own organization endpoints against the project cap',
  async run(context) {
    const writer = await notificationWriter(context);
    for (let index = 0; index < 20; index += 1)
      await forgeForeign(context, `F${String(index)}`, 'disabled');
    expect(await settled(writer.create('E1', 'P1', 'repo'))).toEqual({
      changed: true,
      revision: 1,
    });
  },
};

const foreignTaken: ContractCase = {
  name: 'create accepts an id that only another organization uses',
  async run(context) {
    const writer = await notificationWriter(context);
    await forgeForeign(context, 'E1', 'disabled');
    expect(await settled(writer.create('E1', 'P1', 'repo'))).toEqual({
      changed: true,
      revision: 1,
    });
  },
};

const foreignDeliveries: ContractCase = {
  name: 'delete cancels only the own organization pending deliveries',
  async run(context) {
    const writer = await notificationWriter(context);
    await writer.create('E1');
    await forgeForeign(context, 'E1', 'disabled');
    const { foreign } = orgOf(context);
    const forged = seeder(context.executor).forged;
    await forged(
      "INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at) VALUES (?, 'P1', 'V1', 'O1', 'npm.package.published', 'S', 'widget', '{}', '2026-11-01T00:00:00.000Z')",
      foreign.orgId,
    );
    await forged(
      "INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, next_attempt_at, expires_at, created_at) VALUES (?, 'P1', 'D1', 'V1', 'E1', 1, 'FC', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
      foreign.orgId,
    );
    await writer.repo.delete(writer.org, writer.fence, {
      id: 'E1',
      projectId: 'P1',
      expectedRevision: 1,
      now: new Date().toISOString(),
      event: writer.event('notification.delete', 'E1'),
    });
    expect(
      await context.executor.all({
        sql: 'SELECT state FROM notification_delivery WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ state: 'pending' }]);
  },
};

const FILE = 'notification-write';
const BUILDER = 'createNotificationWriteRepository';
const UPDATE_ENDPOINT = /(?<=update "notification_endpoint" set [^;]*? where )"org_id" = \?/;

export const notificationWriteWaivers: readonly OrgWaiver[] = [
  {
    locate:
      /"(?:actor|i|s|hp_session|hp_project|guard_(?:binding|credential|grant|identity|login|member|perm|role|user)|project)"\."org_id" = /,
    reason:
      'actorHolds repeats the authenticated session, project and permissionRows chain in the fence and failure probes; actor-authority.ts and access.ts mutate those shared guards independently.',
  },
  {
    locate:
      /"cache_epoch"\."org_id" = \?|(?<=from "cache_epoch" where )"org_id" = \?|(?<=update "cache_epoch" set [^;]*? where )"org_id" = \?/,
    reason:
      'The assertGuard epoch bump and the deployment-fault probe are registered with cache-epoch.ts.',
  },
  {
    locate: /(?<=from "project" where "id" = \? and )"org_id" = \?/,
    reason:
      'The prepared credential insert belongs to credential.ts, registered by credential-factory.ts.',
  },
];

function others(...covered: RegExp[]): readonly OrgWaiver[] {
  const all = [
    UPDATE_ENDPOINT,
    /"ready"\."org_id" = \?/,
    /"lookup"\."org_id" = \?/,
    /(?<=update "notification_delivery" set [^;]*? where )"org_id" = \?/,
    /"cap"\."org_id" = \?|cap\.org_id = \?/,
    /taken\.org_id = \?/,
  ];
  return [
    ...notificationWriteWaivers,
    ...all
      .filter((locate) => !covered.some((c) => c.source === locate.source))
      .map((locate) => ({ locate, reason: 'Registered by another entry of this factory.' })),
  ];
}

function entry(contractCase: ContractCase, locate: RegExp, copies = 1): MutationEntry {
  return {
    file: `repositories/${FILE}.ts`,
    builder: BUILDER,
    cases: [contractCase],
    predicates: [
      {
        name: contractCase.name,
        caseName: contractCase.name,
        locate,
        neutral: '(? is not null)',
        copies,
      },
    ],
    waivers: others(locate),
  };
}

export const entries: readonly MutationEntry[] = [
  ...(['enable', 'disable', 'delete'] as const).flatMap((kind) => [
    entry(foreignTarget(kind), UPDATE_ENDPOINT),
    entry(foreignRevision(kind), /"ready"\."org_id" = \?/, 2),
  ]),
  entry(foreignLookup, /"lookup"\."org_id" = \?/),
  entry(foreignCap, /cap\.org_id = \?/),
  entry(foreignTaken, /taken\.org_id = \?/),
  entry(foreignDeliveries, /(?<=update "notification_delivery" set [^;]*? where )"org_id" = \?/),
];
