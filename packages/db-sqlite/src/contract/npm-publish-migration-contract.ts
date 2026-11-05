import { describe, expect, it } from 'vitest';
import {
  orgContext,
  type ScalarSqlExecutor,
  type ScalarSqlValue,
} from '@package-broker/core/db/port';
import { createImportJournalStore, hash } from '../repositories/import-journal.js';
import { createImportRollbackStore } from '../repositories/import-rollback.js';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import type { OpenedPair } from './migration-contract.js';

const NOW = '2026-10-30T00:00:00.000Z';
const EXPIRES = '2026-11-13T00:00:00.000Z';

async function insert(
  executor: ScalarSqlExecutor,
  table: string,
  values: Record<string, ScalarSqlValue>,
) {
  const columns = Object.keys(values);
  await executor.all({
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: Object.values(values),
  });
}

async function seed(executor: ScalarSqlExecutor) {
  await insert(executor, 'organization', { id: 'org', slug: 'test', name: 'Test' });
  await insert(executor, 'user_account', { id: 'user', org_id: 'org', email: 'test@example.test' });
  await insert(executor, 'project', { id: 'project', org_id: 'org', slug: 'test', name: 'Test' });
  await insert(executor, 'source', {
    id: 'source',
    org_id: 'org',
    name: 'test',
    ecosystem: 'npm',
    type: 'hosted',
  });
  await insert(executor, 'package', {
    id: 'package',
    org_id: 'org',
    source_id: 'source',
    ecosystem: 'npm',
    name: 'test',
  });
  await insert(executor, 'version', {
    id: 'version',
    org_id: 'org',
    package_id: 'package',
    version: '1.0.0',
    version_normalized: '1.0.0',
    published_at: NOW,
    published_at_basis: 'broker',
    metadata_json: '{}',
  });
}

const APPROVAL = {
  id: 'approval',
  org_id: 'org',
  package_id: 'package',
  version_id: 'version',
  source_id: 'source',
  hold_approval: 1,
  hold_scan: 0,
  approval_state: 'pending',
  scan_state: 'not_required',
  requested_by_type: 'user',
  requested_by_id: 'user',
  token_id: 'token',
  expires_at: EXPIRES,
};
const ACCESS = {
  id: 'request',
  org_id: 'org',
  package_id: 'package',
  project_id: 'project',
  requested_by_user_id: 'user',
  expires_at: EXPIRES,
};
const README = {
  version_id: 'version',
  org_id: 'org',
  filename: 'README.md',
  body: '# Test\t\r\n',
};

export function describeNpmPublishMigrationContract(
  name: string,
  open: () => Promise<OpenedPair>,
): void {
  async function withDatabase(body: (executor: ScalarSqlExecutor) => Promise<void>) {
    const opened = await open();
    try {
      await migrate(opened.executor, await discoveredMigrations(), { holder: 'npm-publish' });
      await seed(opened.executor);
      await body(opened.executor);
    } finally {
      await opened.close();
    }
  }

  describe(`npm publish migration: ${name}`, () => {
    it('upgrades the published rc.2 database without changing existing rows and skips on rerun', async () => {
      const opened = await open();
      try {
        const sources = (await discoveredMigrations()).slice(0, 2);
        expect(sources.map((s) => s.id)).toEqual(['core:0001_init', 'core:0002_npm_publish']);
        await migrate(opened.executor, sources.slice(0, 1), { holder: 'rc2' });
        await seed(opened.executor);
        await insert(opened.executor, 'token', {
          id: 'token',
          org_id: 'org',
          kind: 'pat',
          selector: 'abcdefghijkl',
          hash: 'a'.repeat(64),
          pepper_version: 1,
          name: 'test',
          scopes_json: '[]',
          user_id: 'user',
          expires_at: EXPIRES,
        });
        await insert(opened.executor, 'project_package', {
          org_id: 'org',
          project_id: 'project',
          package_id: 'package',
          origin: 'explicit',
          ecosystem: 'npm',
          name: 'test',
        });
        await insert(opened.executor, 'dist_tag', {
          org_id: 'org',
          package_id: 'package',
          tag: 'latest',
          version_id: 'version',
        });
        const [source] = await opened.executor.all<Record<string, ScalarSqlValue>>({
          sql: 'SELECT * FROM source WHERE org_id = ?',
          params: ['org'],
        });
        const legacyDomain = Object.fromEntries(
          Object.entries(source!).filter(
            ([key]) =>
              ![
                'id',
                'org_id',
                'created_at',
                'updated_at',
                'last_synced_at',
                'last_accessed_at',
              ].includes(key),
          ),
        );
        const legacyHash = await hash(legacyDomain);
        await insert(opened.executor, 'import_run', {
          id: 'run',
          org_id: 'org',
          source_system: 'test',
          state: 'applied',
          before_image_expires_at: EXPIRES,
        });
        await insert(opened.executor, 'import_ref', {
          id: 'ref',
          org_id: 'org',
          import_run_id: 'run',
          entity_type: 'source',
          entity_id: 'source',
          external_ref: 'source',
          action: 'create',
          content_hash: legacyHash,
        });
        const tables = [
          'organization',
          'user_account',
          'project',
          'source',
          'package',
          'version',
          'token',
          'project_package',
          'dist_tag',
          'import_run',
          'import_ref',
        ];
        const before = await Promise.all(
          tables.map((table) =>
            opened.executor.all<Record<string, ScalarSqlValue>>({
              sql: `SELECT * FROM ${table} ORDER BY 1`,
              params: [],
            }),
          ),
        );
        const ledgerBefore = await opened.executor.all({
          sql: 'SELECT * FROM schema_migration ORDER BY id',
          params: [],
        });
        const result = await migrate(opened.executor, sources, { holder: 'upgrade' });
        expect(result.applied).toEqual(['core:0002_npm_publish']);
        for (const [index, table] of tables.entries()) {
          expect(
            await opened.executor.all({ sql: `SELECT * FROM ${table} ORDER BY 1`, params: [] }),
          ).toEqual(before[index]!.map((row) => expect.objectContaining(row)));
        }
        const ledgerAfter = await opened.executor.all({
          sql: 'SELECT * FROM schema_migration ORDER BY id',
          params: [],
        });
        expect(ledgerAfter).toHaveLength(2);
        expect(ledgerAfter[0]).toEqual(ledgerBefore[0]);
        expect(
          await opened.executor.all({
            sql: 'SELECT require_publish_approval FROM source',
            params: [],
          }),
        ).toEqual([{ require_publish_approval: 0 }]);
        expect(
          await opened.executor.all({
            sql: 'SELECT new_project_access_mode, held_until_active FROM package',
            params: [],
          }),
        ).toEqual([{ new_project_access_mode: 'none', held_until_active: 0 }]);
        const ctx = orgContext('org');
        const store = createImportRollbackStore({ executor: opened.executor, providerAnchors: [] });
        const journal = createImportJournalStore({
          executor: opened.executor,
          providerAnchors: [],
        });
        const [ref] = await journal.rollbackRefs(ctx, 'run');
        const [live] = await store.liveStates(ctx, [{ entityType: 'source', entityId: 'source' }]);
        expect(ref!.contentHash).toBe(legacyHash);
        expect(live).toMatchObject({ exists: true, contentHash: ref!.contentHash });
        expect((await migrate(opened.executor, sources, { holder: 'rerun' })).applied).toEqual([]);
        expect(await opened.executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).toEqual(
          [],
        );
      } finally {
        await opened.close();
      }
    });

    it('round trips approval, access request and version readme defaults', async () => {
      await withDatabase(async (executor) => {
        await insert(executor, 'publish_approval', APPROVAL);
        await insert(executor, 'package_access_request', ACCESS);
        await insert(executor, 'version_readme', README);
        expect(
          await executor.all({
            sql: 'SELECT scan_attempts, revision, required_scanners_json, dist_tags_json, readme_pending, scan_verdict_json FROM publish_approval WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([
          {
            scan_attempts: 0,
            revision: 1,
            required_scanners_json: '[]',
            dist_tags_json: '{}',
            readme_pending: 0,
            scan_verdict_json: '[]',
          },
        ]);
        expect(
          await executor.all({
            sql: 'SELECT state, revision FROM package_access_request WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([{ state: 'pending', revision: 1 }]);
        expect(
          await executor.all({
            sql: 'SELECT body FROM version_readme WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([{ body: README.body }]);
        for (const table of ['publish_approval', 'package_access_request', 'version_readme']) {
          expect(
            await executor.all({
              sql: `SELECT strict FROM pragma_table_list('${table}')`,
              params: [],
            }),
          ).toEqual([{ strict: 1 }]);
        }
      });
    });

    it('indexes approvals by organization/package and user accounts by id/organization', async () => {
      await withDatabase(async (executor) => {
        for (const [index, columns] of [
          ['publish_approval_package', ['org_id', 'package_id']],
          ['user_account_org_id', ['id', 'org_id']],
        ] as const) {
          expect(
            (
              await executor.all<{ name: string }>({
                sql: `SELECT name FROM pragma_index_info('${index}')`,
                params: [],
              })
            ).map((row) => row.name),
          ).toEqual(columns);
        }
      });
    });

    const invalid: [string, string, Record<string, ScalarSqlValue>][] = [
      ['publish_approval_hold_missing', 'publish_approval', { hold_approval: 0 }],
      ['publish_approval_hold_unneeded', 'publish_approval', { approval_state: 'not_required' }],
      ['publish_scan_hold_missing', 'publish_approval', { scan_state: 'queued' }],
      ['publish_scan_hold_unneeded', 'publish_approval', { hold_scan: 1 }],
      ['publish_decision_time_pending', 'publish_approval', { decided_at: NOW }],
      [
        'publish_decision_time_unneeded',
        'publish_approval',
        { hold_approval: 0, approval_state: 'not_required', decided_at: NOW },
      ],
      [
        'publish_decision_time_approved',
        'publish_approval',
        { approval_state: 'approved', decided_by_user_id: 'user' },
      ],
      [
        'publish_decision_time_rejected',
        'publish_approval',
        { approval_state: 'rejected', decided_by_user_id: 'user' },
      ],
      [
        'publish_decision_time_expired',
        'publish_approval',
        { approval_state: 'expired', decided_by_user_id: null },
      ],
      ['access_actor_approved', 'package_access_request', { state: 'approved', decided_at: NOW }],
      ['access_actor_rejected', 'package_access_request', { state: 'rejected', decided_at: NOW }],
      [
        'access_expiry_actor',
        'package_access_request',
        { state: 'expired', decided_at: NOW, decided_by_user_id: 'user' },
      ],
      ['access_time_pending', 'package_access_request', { decided_at: NOW }],
      [
        'access_time_approved',
        'package_access_request',
        { state: 'approved', decided_by_user_id: 'user' },
      ],
      [
        'access_time_rejected',
        'package_access_request',
        { state: 'rejected', decided_by_user_id: 'user' },
      ],
      [
        'access_time_expired',
        'package_access_request',
        { state: 'expired', decided_by_user_id: null },
      ],
      ['access_reason_bytes', 'package_access_request', { reason: 'é'.repeat(501) }],
      [
        'access_reason_control_0',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(0) + 'text' },
      ],
      [
        'access_reason_control_1',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(1) + 'text' },
      ],
      [
        'access_reason_control_8',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(8) + 'text' },
      ],
      [
        'access_reason_control_11',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(11) + 'text' },
      ],
      [
        'access_reason_control_12',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(12) + 'text' },
      ],
      [
        'access_reason_control_14',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(14) + 'text' },
      ],
      [
        'access_reason_control_27',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(27) + 'text' },
      ],
      [
        'access_reason_control_31',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(31) + 'text' },
      ],
      [
        'access_reason_control_127',
        'package_access_request',
        { reason: 'bad' + String.fromCharCode(127) + 'text' },
      ],
      [
        'access_decision_reason_bytes',
        'package_access_request',
        { decision_reason: 'é'.repeat(501) },
      ],
      [
        'access_decision_reason_control_0',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(0) + 'text' },
      ],
      [
        'access_decision_reason_control_1',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(1) + 'text' },
      ],
      [
        'access_decision_reason_control_8',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(8) + 'text' },
      ],
      [
        'access_decision_reason_control_11',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(11) + 'text' },
      ],
      [
        'access_decision_reason_control_12',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(12) + 'text' },
      ],
      [
        'access_decision_reason_control_14',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(14) + 'text' },
      ],
      [
        'access_decision_reason_control_27',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(27) + 'text' },
      ],
      [
        'access_decision_reason_control_31',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(31) + 'text' },
      ],
      [
        'access_decision_reason_control_127',
        'package_access_request',
        { decision_reason: 'bad' + String.fromCharCode(127) + 'text' },
      ],
      ['publish_hold_approval', 'publish_approval', { hold_approval: 2 }],
      ['publish_hold_scan', 'publish_approval', { hold_scan: -1 }],
      ['publish_approval_state', 'publish_approval', { approval_state: 'invalid' }],
      ['publish_scan_state', 'publish_approval', { scan_state: 'invalid' }],
      ['publish_scanners_json', 'publish_approval', { required_scanners_json: '{' }],
      ['publish_tags_json', 'publish_approval', { dist_tags_json: '{' }],
      ['publish_verdict_json', 'publish_approval', { scan_verdict_json: '{' }],
      ['publish_attempts', 'publish_approval', { scan_attempts: -1 }],
      ['publish_requester_type', 'publish_approval', { requested_by_type: 'invalid' }],
      ['publish_readme_pending', 'publish_approval', { readme_pending: 2 }],
      ['publish_revision', 'publish_approval', { revision: 0 }],
      [
        'publish_decision_actor',
        'publish_approval',
        { approval_state: 'approved', decided_at: NOW },
      ],
      [
        'publish_expiry_actor',
        'publish_approval',
        { approval_state: 'expired', decided_by_user_id: 'user', decided_at: NOW },
      ],
      ['publish_reason_bytes', 'publish_approval', { decision_reason: 'é'.repeat(501) }],
      ['access_state', 'package_access_request', { state: 'invalid' }],
      ['access_revision', 'package_access_request', { revision: 0 }],
      ['readme_controls', 'version_readme', { body: 'bad\u0000body' }],
      ['readme_controls_other', 'version_readme', { body: 'bad\u001bbody' }],
      ['readme_body_bytes', 'version_readme', { body: 'é'.repeat(262145) }],
    ];
    for (const [guard, table, values] of invalid) {
      it(`refuses ${guard}`, async () => {
        await withDatabase(async (executor) => {
          const base =
            table === 'publish_approval'
              ? APPROVAL
              : table === 'package_access_request'
                ? ACCESS
                : README;
          await expect(insert(executor, table, { ...base, ...values })).rejects.toMatchObject({
            kind: 'check',
          });
        });
      });
    }
    it('requires an actor for rejected decisions too; accepts both human decisions and unattributed expiry', async () => {
      await withDatabase(async (executor) => {
        await expect(
          insert(executor, 'publish_approval', {
            ...APPROVAL,
            approval_state: 'rejected',
            decided_at: NOW,
          }),
        ).rejects.toMatchObject({ kind: 'check' });
        for (const state of ['approved', 'rejected', 'expired']) {
          await insert(executor, 'publish_approval', {
            ...APPROVAL,
            approval_state: state,
            decided_at: NOW,
            decided_by_user_id: state === 'expired' ? null : 'user',
            decision_reason: 'é'.repeat(500),
          });
          await executor.all({
            sql: 'DELETE FROM publish_approval WHERE org_id = ?',
            params: ['org'],
          });
        }
        for (const state of ['approved', 'rejected', 'expired']) {
          await insert(executor, 'package_access_request', {
            ...ACCESS,
            state,
            decided_by_user_id: state === 'expired' ? null : 'user',
            decided_at: NOW,
            reason: 'é'.repeat(498) + '\t\r\nX',
            decision_reason: 'é'.repeat(500),
          });
          await executor.all({
            sql: 'DELETE FROM package_access_request WHERE org_id = ?',
            params: ['org'],
          });
        }
        await insert(executor, 'publish_approval', {
          ...APPROVAL,
          hold_approval: 0,
          approval_state: 'not_required',
          hold_scan: 1,
          scan_state: 'queued',
        });
        await insert(executor, 'version_readme', { ...README, body: 'é'.repeat(262144) });
      });
    });
    for (const [table, columns] of [
      ['source', { require_publish_approval: 2 }],
      ['package', { new_project_access_mode: 'invalid' }],
      ['package', { held_until_active: -1 }],
    ] as const) {
      const column = Object.keys(columns)[0]!;
      it(`refuses ${column}`, async () => {
        await withDatabase(async (executor) => {
          await expect(
            executor.all({
              sql: `UPDATE ${table} SET ${column} = ? WHERE org_id = ?`,
              params: [Object.values(columns)[0]!, 'org'],
            }),
          ).rejects.toMatchObject({ kind: 'check' });
        });
      });
    }
    it('allows only one approval per version and one pending request per package/project', async () => {
      await withDatabase(async (executor) => {
        await insert(executor, 'publish_approval', APPROVAL);
        await expect(
          insert(executor, 'publish_approval', { ...APPROVAL, id: 'duplicate' }),
        ).rejects.toMatchObject({ kind: 'unique' });
        await insert(executor, 'package_access_request', ACCESS);
        await expect(
          insert(executor, 'package_access_request', { ...ACCESS, id: 'duplicate' }),
        ).rejects.toMatchObject({ kind: 'unique' });
        await insert(executor, 'package_access_request', {
          ...ACCESS,
          id: 'decided',
          state: 'rejected',
          decided_by_user_id: 'user',
          decided_at: NOW,
        });
        await executor.all({
          sql: "UPDATE package_access_request SET state = 'expired', decided_at = '2026-10-30T00:00:00.000Z' WHERE id = ? AND org_id = ?",
          params: ['request', 'org'],
        });
        await insert(executor, 'package_access_request', { ...ACCESS, id: 'new' });
      });
    });
    for (const [table, base, columns] of [
      [
        'publish_approval',
        APPROVAL,
        ['package_id', 'version_id', 'source_id', 'route_project_id', 'decided_by_user_id'],
      ],
      [
        'package_access_request',
        ACCESS,
        ['package_id', 'project_id', 'requested_by_user_id', 'decided_by_user_id'],
      ],
      ['version_readme', README, ['version_id']],
    ] as const) {
      for (const column of columns) {
        it(`refuses cross-organization ${table}.${column}`, async () => {
          await withDatabase(async (executor) => {
            await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
            await insert(executor, 'organization', { id: 'other', slug: 'other', name: 'Other' });
            await insert(executor, 'user_account', {
              id: 'other-user',
              org_id: 'other',
              email: 'other@example.test',
            });
            await insert(executor, 'project', {
              id: 'other-project',
              org_id: 'other',
              slug: 'other',
              name: 'Other',
            });
            await insert(executor, 'source', {
              id: 'other-source',
              org_id: 'other',
              name: 'other',
              ecosystem: 'npm',
              type: 'hosted',
            });
            await insert(executor, 'package', {
              id: 'other-package',
              org_id: 'other',
              source_id: 'other-source',
              ecosystem: 'npm',
              name: 'other',
            });
            await insert(executor, 'version', {
              id: 'other-version',
              org_id: 'other',
              package_id: 'other-package',
              version: '1.0.0',
              version_normalized: '1.0.0',
              published_at: NOW,
              published_at_basis: 'broker',
              metadata_json: '{}',
            });
            const parent = column.includes('user')
              ? 'user'
              : column === 'route_project_id'
                ? 'project'
                : column.slice(0, -3);
            await expect(
              insert(executor, table, { ...base, [column]: `other-${parent}` }),
            ).rejects.toMatchObject({ kind: 'foreign_key' });
          });
        });
      }
    }
    it('rolls back the whole batch when a new constraint refuses a write', async () => {
      await withDatabase(async (executor) => {
        await expect(
          executor.batch([
            {
              sql: 'INSERT INTO version_readme (version_id, org_id, filename, body) VALUES (?, ?, ?, ?)',
              params: ['version', 'org', 'README', 'test'],
            },
            {
              sql: 'INSERT INTO package_access_request (id, org_id, package_id, project_id, requested_by_user_id, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)',
              params: ['bad', 'org', 'package', 'project', 'user', EXPIRES, 'invalid'],
            },
          ]),
        ).rejects.toMatchObject({ kind: 'check' });
        expect(
          await executor.all({
            sql: 'SELECT version_id FROM version_readme WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([]);
      });
    });
  });
}
