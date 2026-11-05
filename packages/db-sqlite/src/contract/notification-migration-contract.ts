import { describe, expect, it } from 'vitest';
import type { ScalarSqlExecutor, ScalarSqlValue } from '@package-broker/core/db/port';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';

export interface OpenedNotificationDatabase {
  readonly executor: ScalarSqlExecutor;
  close(): Promise<void>;
}

const NOW = '2026-11-01T12:00:00.000Z';
const LATER = '2026-11-02T12:00:00.000Z';
const MIGRATION = 'core:0009_npm_notifications';
const TABLES = [
  'notification_endpoint',
  'notification_event',
  'notification_delivery',
  'notification_attempt',
] as const;
const FROZEN: Readonly<Record<string, string>> = {
  'core:0001_init': 'a1005fb24893ffe9174ae1f1642b3f1270d853476183a47ce2b5e4d32471e2fb',
  'core:0002_npm_publish': '1beaf4be82bc086b014d5999d85e37b2ead8b04acc5db98d6720d08d5d5368cb',
  'core:0003_npm_identity': '1b7ee8616cdbf062cea7fd10458b8df9739cb19323ce765f2f2b3068552288fa',
  'core:0004_source_revision': '9971e927c07c1b2e1ff7da3f73b4673b19c80be48329a35fc23def5a95aee6ed',
  'core:0005_package_settings_revision':
    'ed867ced9882400ec2e51bd9cdd1100426470d130091b4a8e95ff0bdd025c2cb',
  'core:0006_npm_login_handoff': 'e1140895bb8b68e2b05054dc814d50e71ab1cf745638739310266a43dbe26117',
  'core:0007_npm_vcs_build_outcomes':
    'f8434d0e092809b35c472a2f1ba1b317836415694e909f929df3e6559f2e7891',
  'core:0008_registry_policy': '9ba4c9df12b3b17decaea7a7c3ed41222dbb6ffba0af1b53a054e3a6b48d72cc',
};

export const ENDPOINT: Readonly<Record<string, ScalarSqlValue>> = {
  org_id: 'org',
  project_id: 'project',
  id: 'endpoint',
  name: 'Release hook',
  method: 'POST',
  events_json: '["npm.package.published"]',
  package_pattern: '*',
  credential_id: 'credential',
  created_at: NOW,
  updated_at: NOW,
};
export const EVENT: Readonly<Record<string, ScalarSqlValue>> = {
  org_id: 'org',
  project_id: 'project',
  id: 'event',
  operation_id: 'operation',
  event_type: 'npm.package.published',
  source_id: 'source',
  package_key: '@scope/pkg',
  payload_json: '{"schemaVersion":1}',
  occurred_at: NOW,
};
export const DELIVERY: Readonly<Record<string, ScalarSqlValue>> = {
  org_id: 'org',
  project_id: 'project',
  id: 'delivery',
  event_id: 'event',
  endpoint_id: 'endpoint',
  endpoint_revision: 1,
  configuration_credential_id: 'credential',
  next_attempt_at: NOW,
  expires_at: LATER,
  created_at: NOW,
};
export const ATTEMPT: Readonly<Record<string, ScalarSqlValue>> = {
  org_id: 'org',
  project_id: 'project',
  delivery_id: 'delivery',
  attempt: 1,
  job_id: 'job',
  fence: 1,
  outcome: 'started',
  started_at: NOW,
};
function base(table: (typeof TABLES)[number]): Readonly<Record<string, ScalarSqlValue>> {
  switch (table) {
    case 'notification_endpoint':
      return ENDPOINT;
    case 'notification_event':
      return EVENT;
    case 'notification_delivery':
      return DELIVERY;
    case 'notification_attempt':
      return ATTEMPT;
  }
}

export async function insertRow(
  executor: ScalarSqlExecutor,
  table: string,
  values: Readonly<Record<string, ScalarSqlValue>>,
): Promise<void> {
  const columns = Object.keys(values);
  await executor.all({
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: Object.values(values),
  });
}

export async function seedNotificationScope(
  executor: ScalarSqlExecutor,
  org: string,
  project: string,
  credentials: readonly string[],
): Promise<void> {
  await insertRow(executor, 'project', { id: project, org_id: org, slug: project, name: project });
  for (const credential of credentials) {
    await executor.all({
      sql: "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, 'npm-notification', x'00', zeroblob(12), 1, 'aad')",
      params: [credential, org, project],
    });
  }
}

async function seed(executor: ScalarSqlExecutor): Promise<void> {
  await insertRow(executor, 'organization', { id: 'org', slug: 'org', name: 'Org' });
  await seedNotificationScope(executor, 'org', 'project', ['credential', 'body']);
}

async function seedForeign(executor: ScalarSqlExecutor): Promise<void> {
  await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
  await insertRow(executor, 'organization', { id: 'other', slug: 'other', name: 'Other' });
  await seedNotificationScope(executor, 'other', 'other-project', ['other-credential']);
  await seedNotificationScope(executor, 'org', 'sibling', ['sibling-credential']);
  await insertRow(executor, 'notification_endpoint', {
    ...ENDPOINT,
    project_id: 'sibling',
    id: 'sibling-endpoint',
    credential_id: 'sibling-credential',
  });
  await insertRow(executor, 'notification_event', {
    ...EVENT,
    project_id: 'sibling',
    id: 'sibling-event',
    operation_id: 'sibling-operation',
  });
}

async function seedChain(executor: ScalarSqlExecutor): Promise<void> {
  await insertRow(executor, 'notification_endpoint', ENDPOINT);
  await insertRow(executor, 'notification_event', EVENT);
  await insertRow(executor, 'notification_delivery', DELIVERY);
}

async function columnsOf(executor: ScalarSqlExecutor, index: string): Promise<string[]> {
  return (
    await executor.all<{ name: string }>({
      sql: `SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`,
      params: [],
    })
  ).map((row) => row.name);
}

const INVALID: readonly [string, (typeof TABLES)[number], Record<string, ScalarSqlValue>][] = [
  ['notification_endpoint_name', 'notification_endpoint', { name: '' }],
  ['notification_endpoint_name', 'notification_endpoint', { name: 'n'.repeat(81) }],
  ['notification_endpoint_method', 'notification_endpoint', { method: 'GET' }],
  ['notification_endpoint_events', 'notification_endpoint', { events_json: '[' }],
  ['notification_endpoint_events', 'notification_endpoint', { events_json: '{}' }],
  ['notification_endpoint_events', 'notification_endpoint', { events_json: '[]' }],
  [
    'notification_endpoint_events',
    'notification_endpoint',
    { events_json: JSON.stringify(['x'.repeat(260)]) },
  ],
  ['notification_endpoint_pattern', 'notification_endpoint', { package_pattern: '' }],
  ['notification_endpoint_pattern', 'notification_endpoint', { package_pattern: 'p'.repeat(51) }],
  ['notification_endpoint_headers', 'notification_endpoint', { headers_configured: 2 }],
  ['notification_endpoint_template', 'notification_endpoint', { template_configured: -1 }],
  ['notification_endpoint_revision', 'notification_endpoint', { revision: 0 }],
  ['notification_endpoint_state', 'notification_endpoint', { state: 'paused' }],
  [
    'notification_endpoint_reason',
    'notification_endpoint',
    { state: 'disabled', disabled_reason: 'other' },
  ],
  [
    'notification_endpoint_enabled',
    'notification_endpoint',
    { state: 'enabled', disabled_reason: 'manual' },
  ],
  ['notification_endpoint_streak', 'notification_endpoint', { failure_streak: -1 }],
  ['notification_event_ordinal', 'notification_event', { ordinal: -1 }],
  ['notification_event_type', 'notification_event', { event_type: 'npm.package.fetched' }],
  ['notification_event_key', 'notification_event', { package_key: '' }],
  ['notification_event_key', 'notification_event', { package_key: 'é'.repeat(257) }],
  ['notification_event_payload', 'notification_event', { payload_json: '{' }],
  [
    'notification_event_payload',
    'notification_event',
    { payload_json: JSON.stringify({ pad: 'x'.repeat(16380) }) },
  ],
  ['notification_event_generation', 'notification_event', { dispatch_generation: 0 }],
  ['notification_delivery_endpoint_revision', 'notification_delivery', { endpoint_revision: 0 }],
  ['notification_delivery_state', 'notification_delivery', { state: 'queued' }],
  ['notification_delivery_attempts', 'notification_delivery', { attempts: 9 }],
  ['notification_delivery_attempts', 'notification_delivery', { attempts: -1 }],
  ['notification_delivery_generation', 'notification_delivery', { job_generation: 0 }],
  ['notification_delivery_fence', 'notification_delivery', { active_fence: 0 }],
  ['notification_delivery_revision', 'notification_delivery', { revision: 0 }],
  ['notification_delivery_status', 'notification_delivery', { last_status: 99 }],
  ['notification_delivery_status', 'notification_delivery', { last_status: 600 }],
  ['notification_delivery_outcome', 'notification_delivery', { outcome_code: 'bad' }],
  ['notification_delivery_finished', 'notification_delivery', { state: 'delivered' }],
  ['notification_delivery_finished', 'notification_delivery', { finished_at: NOW }],
  ['notification_delivery_sending', 'notification_delivery', { state: 'sending' }],
  [
    'notification_delivery_sending',
    'notification_delivery',
    { state: 'sending', active_job_id: 'job' },
  ],
  ['notification_attempt_number', 'notification_attempt', { attempt: 0 }],
  ['notification_attempt_number', 'notification_attempt', { attempt: 9 }],
  ['notification_attempt_fence', 'notification_attempt', { fence: 0 }],
  ['notification_attempt_outcome', 'notification_attempt', { outcome: 'pending' }],
  ['notification_attempt_code', 'notification_attempt', { outcome_code: 'expired' }],
  ['notification_attempt_status', 'notification_attempt', { status: 600 }],
  ['notification_attempt_duration', 'notification_attempt', { duration_ms: -1 }],
  ['notification_attempt_finished', 'notification_attempt', { finished_at: NOW }],
  ['notification_attempt_finished', 'notification_attempt', { outcome: 'delivered' }],
];

const FOREIGN: readonly [string, (typeof TABLES)[number], Record<string, ScalarSqlValue>][] = [
  [
    'endpoint in a foreign organization project',
    'notification_endpoint',
    { project_id: 'other-project' },
  ],
  [
    'endpoint credential of a sibling project',
    'notification_endpoint',
    { credential_id: 'sibling-credential' },
  ],
  [
    'endpoint credential of a foreign organization',
    'notification_endpoint',
    { credential_id: 'other-credential' },
  ],
  [
    'event in a foreign organization project',
    'notification_event',
    { project_id: 'other-project' },
  ],
  ['delivery of a sibling project event', 'notification_delivery', { event_id: 'sibling-event' }],
  [
    'delivery to a sibling project endpoint',
    'notification_delivery',
    { endpoint_id: 'sibling-endpoint' },
  ],
  [
    'delivery configuration credential of a sibling project',
    'notification_delivery',
    { configuration_credential_id: 'sibling-credential' },
  ],
  [
    'delivery body credential of a foreign organization',
    'notification_delivery',
    { body_credential_id: 'other-credential' },
  ],
  ['attempt for a missing delivery', 'notification_attempt', { delivery_id: 'missing' }],
  ['attempt under a sibling project', 'notification_attempt', { project_id: 'sibling' }],
];

export function describeNotificationMigrationContract(
  name: string,
  open: () => Promise<OpenedNotificationDatabase>,
): void {
  async function withDatabase(body: (executor: ScalarSqlExecutor) => Promise<void>): Promise<void> {
    const opened = await open();
    try {
      await opened.executor.all({ sql: 'PRAGMA foreign_keys = ON', params: [] });
      await migrate(opened.executor, await discoveredMigrations(), { holder: 'notifications' });
      await seed(opened.executor);
      await body(opened.executor);
    } finally {
      await opened.close();
    }
  }

  describe(`notification migration: ${name}`, () => {
    it('keeps every earlier migration byte-identical', async () => {
      const sources = await discoveredMigrations();
      const index = sources.findIndex((source) => source.id === MIGRATION);
      expect(index).toBeGreaterThan(0);
      expect(
        Object.fromEntries(sources.slice(0, index).map((source) => [source.id, source.checksum])),
      ).toEqual(FROZEN);
      expect(sources.at(index)?.phase).toBe('expand');
    });

    it('upgrades a populated database additively and skips on rerun', async () => {
      const opened = await open();
      try {
        const sources = await discoveredMigrations();
        const index = sources.findIndex((source) => source.id === MIGRATION);
        await migrate(opened.executor, sources.slice(0, index), { holder: 'baseline' });
        await seed(opened.executor);
        const before = await opened.executor.all({
          sql: 'SELECT id, org_id, project_id, kind, aad FROM credential ORDER BY id',
          params: [],
        });
        const ledger = await opened.executor.all({
          sql: 'SELECT id, checksum FROM schema_migration ORDER BY id',
          params: [],
        });
        const result = await migrate(opened.executor, sources.slice(0, index + 1), {
          holder: 'upgrade',
        });
        expect(result.applied).toEqual([MIGRATION]);
        expect(
          await opened.executor.all({
            sql: 'SELECT id, org_id, project_id, kind, aad FROM credential ORDER BY id',
            params: [],
          }),
        ).toEqual(before);
        expect(
          await opened.executor.all({
            sql: 'SELECT id, checksum FROM schema_migration ORDER BY id',
            params: [],
          }),
        ).toEqual([...ledger, { id: MIGRATION, checksum: sources.at(index)?.checksum }]);
        for (const table of TABLES) {
          expect(
            await opened.executor.all({ sql: `SELECT count(*) AS n FROM ${table}`, params: [] }),
          ).toEqual([{ n: 0 }]);
        }
        expect(
          (await migrate(opened.executor, sources.slice(0, index + 1), { holder: 'rerun' }))
            .applied,
        ).toEqual([]);
        expect(await opened.executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).toEqual(
          [],
        );
      } finally {
        await opened.close();
      }
    });

    it('creates strict tables and org-leading indexes', async () => {
      await withDatabase(async (executor) => {
        for (const table of TABLES) {
          expect(
            await executor.all({
              sql: `SELECT strict FROM pragma_table_list('${table}')`,
              params: [],
            }),
          ).toEqual([{ strict: 1 }]);
        }
        for (const [index, columns] of [
          ['credential_notification_scope', ['org_id', 'project_id', 'id']],
          ['notification_endpoint_project', ['org_id', 'project_id', 'state', 'id']],
          ['notification_event_dispatch', ['org_id', 'dispatched_at', 'id']],
          ['notification_event_retention', ['org_id', 'occurred_at', 'id']],
          ['notification_delivery_due', ['org_id', 'state', 'next_attempt_at', 'id']],
          [
            'notification_delivery_history',
            ['org_id', 'project_id', 'endpoint_id', 'created_at', 'id'],
          ],
          ['notification_delivery_retention', ['org_id', 'finished_at', 'id']],
          ['notification_attempt_started', ['org_id', 'outcome', 'started_at', 'delivery_id']],
        ] as const) {
          expect(await columnsOf(executor, index)).toEqual(columns);
        }
      });
    });

    it('round trips the defaults of every notification table', async () => {
      await withDatabase(async (executor) => {
        await seedChain(executor);
        await insertRow(executor, 'notification_attempt', ATTEMPT);
        expect(
          await executor.all({
            sql: 'SELECT revision, state, disabled_reason, failure_streak, headers_configured, template_configured, last_op_id FROM notification_endpoint WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([
          {
            revision: 1,
            state: 'disabled',
            disabled_reason: null,
            failure_streak: 0,
            headers_configured: 0,
            template_configured: 0,
            last_op_id: null,
          },
        ]);
        expect(
          await executor.all({
            sql: 'SELECT ordinal, dispatched_at, dispatch_generation FROM notification_event WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([{ ordinal: 0, dispatched_at: null, dispatch_generation: 1 }]);
        expect(
          await executor.all({
            sql: 'SELECT state, attempts, job_generation, revision, body_credential_id, finished_at FROM notification_delivery WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([
          {
            state: 'pending',
            attempts: 0,
            job_generation: 1,
            revision: 1,
            body_credential_id: null,
            finished_at: null,
          },
        ]);
        await executor.all({
          sql: "UPDATE notification_delivery SET state = 'sending', active_job_id = 'job', active_fence = 1, body_credential_id = 'body', attempts = 8 WHERE org_id = ? AND id = ?",
          params: ['org', 'delivery'],
        });
        await executor.all({
          sql: "UPDATE notification_attempt SET outcome = 'delivered', outcome_code = 'ok', status = 204, duration_ms = 0, finished_at = ? WHERE org_id = ?",
          params: [LATER, 'org'],
        });
        await executor.all({
          sql: "UPDATE notification_delivery SET state = 'delivered', outcome_code = 'ok', last_status = 204, finished_at = ? WHERE org_id = ?",
          params: [LATER, 'org'],
        });
        await executor.all({
          sql: "UPDATE notification_endpoint SET state = 'enabled', events_json = ?, package_pattern = ? WHERE org_id = ?",
          params: [
            JSON.stringify(['npm.package.published', 'npm.package.released']),
            'p'.repeat(50),
            'org',
          ],
        });
      });
    });

    for (const [constraint, table, values] of INVALID) {
      it(`refuses ${table} rows violating ${constraint}: ${JSON.stringify(values).slice(0, 60)}`, async () => {
        await withDatabase(async (executor) => {
          if (table === 'notification_delivery') {
            await insertRow(executor, 'notification_endpoint', ENDPOINT);
            await insertRow(executor, 'notification_event', EVENT);
          }
          if (table === 'notification_attempt') await seedChain(executor);
          const error = await insertRow(executor, table, { ...base(table), ...values }).then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toMatchObject({ kind: 'check' });
          expect(String((error as Error).message)).toContain(constraint);
        });
      });
    }

    it('allows a disabled endpoint without a reason and every disabled reason', async () => {
      await withDatabase(async (executor) => {
        for (const reason of [
          null,
          'manual',
          'configuration_changed',
          'failures',
          'credentials',
          'policy',
          'gone',
        ]) {
          await insertRow(executor, 'notification_endpoint', {
            ...ENDPOINT,
            id: `endpoint-${reason ?? 'none'}`,
            disabled_reason: reason,
          });
        }
        await insertRow(executor, 'notification_endpoint', {
          ...ENDPOINT,
          id: 'deleted',
          state: 'deleted',
          disabled_reason: 'manual',
        });
      });
    });

    it('deduplicates events per operation and deliveries per event endpoint', async () => {
      await withDatabase(async (executor) => {
        await seedChain(executor);
        await expect(
          insertRow(executor, 'notification_event', { ...EVENT, id: 'duplicate' }),
        ).rejects.toMatchObject({ kind: 'unique' });
        await insertRow(executor, 'notification_event', { ...EVENT, id: 'next', ordinal: 1 });
        await expect(
          insertRow(executor, 'notification_delivery', { ...DELIVERY, id: 'duplicate' }),
        ).rejects.toMatchObject({ kind: 'unique' });
        await expect(
          insertRow(executor, 'notification_attempt', ATTEMPT).then(() =>
            insertRow(executor, 'notification_attempt', { ...ATTEMPT, job_id: 'other' }),
          ),
        ).rejects.toMatchObject({ kind: 'unique' });
      });
    });

    for (const [label, table, values] of FOREIGN) {
      it(`refuses ${label}`, async () => {
        await withDatabase(async (executor) => {
          await seedForeign(executor);
          if (table === 'notification_delivery') {
            await insertRow(executor, 'notification_endpoint', ENDPOINT);
            await insertRow(executor, 'notification_event', EVENT);
          }
          if (table === 'notification_attempt') await seedChain(executor);
          await expect(
            insertRow(executor, table, { ...base(table), ...values }),
          ).rejects.toMatchObject({
            kind: 'foreign_key',
          });
        });
      });
    }

    it('cascades attempts with their delivery and keeps events and endpoints', async () => {
      await withDatabase(async (executor) => {
        await seedChain(executor);
        await insertRow(executor, 'notification_attempt', ATTEMPT);
        await executor.all({
          sql: 'DELETE FROM notification_delivery WHERE org_id = ? AND id = ?',
          params: ['org', 'delivery'],
        });
        for (const [table, n] of [
          ['notification_attempt', 0],
          ['notification_event', 1],
          ['notification_endpoint', 1],
        ] as const) {
          expect(
            await executor.all({ sql: `SELECT count(*) AS n FROM ${table}`, params: [] }),
          ).toEqual([{ n }]);
        }
        await expect(
          executor.all({
            sql: 'DELETE FROM notification_event WHERE org_id = ? AND id = ?',
            params: ['org', 'missing'],
          }),
        ).resolves.toEqual([]);
      });
    });

    it('refuses to delete an endpoint, event or credential that a delivery references', async () => {
      await withDatabase(async (executor) => {
        await seedChain(executor);
        for (const [table, id] of [
          ['notification_endpoint', 'endpoint'],
          ['notification_event', 'event'],
          ['credential', 'credential'],
        ] as const) {
          await expect(
            executor.all({
              sql: `DELETE FROM ${table} WHERE org_id = ? AND id = ?`,
              params: ['org', id],
            }),
          ).rejects.toMatchObject({ kind: 'foreign_key' });
        }
      });
    });
  });
}
