import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlValue } from '@package-broker/core/db/port';
import { BACKUP_SCOPE } from '../backup-scope.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource } from './source.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);
const ORG = 'org-a';
const NOW = '2026-10-17T09:00:00.000Z';
let opened: OpenedExecutor;

async function migrateAll(): Promise<void> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sources = await Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
  await migrate(opened.executor, sources, { holder: 'api-audit-migration-test' });
}

async function rows<R>(sql: string, params: readonly SqlValue[] = []): Promise<R[]> {
  return opened.executor.all<R>({ sql, params });
}

async function insert(table: string, values: Record<string, SqlValue>): Promise<void> {
  const names = Object.keys(values);
  await rows(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(values),
  );
}

function pending(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
  return {
    id: 'pending-a',
    org_id: ORG,
    created_at: NOW,
    actor_type: 'system',
    action: 'project.create',
    target_type: 'project',
    ...overrides,
  };
}

function replay(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
  return {
    org_id: ORG,
    principal_key: 'user:a',
    key: 'request-a',
    route: '/api/projects',
    request_hash: 'a'.repeat(64),
    status: 201,
    response_json: '{}',
    created_at: NOW,
    expires_at: '2026-10-18T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  opened = openNodeSqliteExecutor();
});

afterEach(async () => {
  await opened.close();
});

describe('baseline schema', () => {
  beforeEach(async () => {
    await migrateAll();
    await insert('organization', { id: ORG, slug: 'acme', name: 'Acme' });
  });

  it('creates both STRICT tables and all three indexes in the expand phase without audit triggers', async () => {
    expect(
      await rows(
        "SELECT name FROM sqlite_master WHERE name IN ('audit_pending', 'api_idempotency', 'audit_pending_org_id', 'api_idempotency_expiry', 'audit_event_action') ORDER BY name",
      ),
    ).toEqual(
      [
        'api_idempotency',
        'api_idempotency_expiry',
        'audit_event_action',
        'audit_pending',
        'audit_pending_org_id',
      ].map((name) => ({ name })),
    );
    expect(
      await rows(
        "SELECT name, strict FROM pragma_table_list WHERE name IN ('audit_pending', 'api_idempotency') ORDER BY name",
      ),
    ).toEqual([
      { name: 'api_idempotency', strict: 1 },
      { name: 'audit_pending', strict: 1 },
    ]);
    const source = await loadMigrationSource(
      'core',
      '0001_init.sql',
      readFileSync(new URL('0001_init.sql', migrationsUrl), 'utf8'),
    );
    expect(source.phase).toBe('expand');
    expect(
      await rows(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'source_sync_%'
      AND name NOT IN ('package_ecosystem_matches_source_insert',
        'package_ecosystem_matches_source_update', 'source_ecosystem_locked_with_packages')`),
    ).toEqual([]);
    for (const [index, columns] of [
      ['audit_pending_org_id', ['org_id', 'id']],
      ['api_idempotency_expiry', ['org_id', 'expires_at']],
      ['audit_event_action', ['org_id', 'action', 'seq']],
    ] as const) {
      expect(
        (
          await rows<{ name: string }>(
            `SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`,
          )
        ).map((row) => row.name),
      ).toEqual(columns);
    }
  });

  it('has the exact pending columns, excluding seq, prev_hash and hash', async () => {
    const columns = await rows<{ name: string }>('PRAGMA table_info(audit_pending)');
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'org_id',
      'created_at',
      'actor_type',
      'actor_id',
      'token_selector',
      'source_ip',
      'action',
      'target_type',
      'target_id',
      'project_id',
      'payload_json',
    ]);
  });

  it('defaults the pending payload to an empty object', async () => {
    await insert('audit_pending', pending());
    expect(await rows('SELECT payload_json FROM audit_pending WHERE org_id = ?', [ORG])).toEqual([
      { payload_json: '{}' },
    ]);
  });

  it('refuses a 4097-byte pending JSON payload', async () => {
    const payload = JSON.stringify('x'.repeat(4095));
    expect(Buffer.byteLength(payload)).toBe(4097);
    await expect(insert('audit_pending', pending({ payload_json: payload }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('refuses invalid pending JSON', async () => {
    await expect(insert('audit_pending', pending({ payload_json: '{bad' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('measures the pending payload limit in UTF-8 bytes', async () => {
    await expect(
      insert('audit_pending', pending({ payload_json: JSON.stringify('é'.repeat(2048)) })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('accepts a 4096-byte pending JSON payload and all audit actor types', async () => {
    for (const actor_type of ['user', 'service_principal', 'customer', 'system']) {
      await insert(
        'audit_pending',
        pending({ id: actor_type, actor_type, payload_json: JSON.stringify('é'.repeat(2047)) }),
      );
    }
    expect(await rows('SELECT id FROM audit_pending WHERE org_id = ?', [ORG])).toHaveLength(4);
  });

  it.each([
    ['an unknown actor', { actor_type: 'unknown' }],
    ['an action shorter than three characters', { action: 'ab' }],
    ['an action longer than 64 characters', { action: 'a'.repeat(65) }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(insert('audit_pending', pending(overrides))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('refuses a duplicate organization, principal and idempotency key', async () => {
    await insert('api_idempotency', replay());
    await expect(insert('api_idempotency', replay())).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('accepts the same key for another principal', async () => {
    await insert('api_idempotency', replay());
    await insert('api_idempotency', replay({ principal_key: 'user:b' }));
    expect(await rows('SELECT key FROM api_idempotency WHERE org_id = ?', [ORG])).toHaveLength(2);
  });

  it('accepts the same key and principal for another organization', async () => {
    await rows('DROP INDEX organization_singleton');
    await insert('organization', { id: 'org-b', slug: 'other', name: 'Other' });
    await insert('api_idempotency', replay());
    await insert('api_idempotency', replay({ org_id: 'org-b' }));
    expect(await rows('SELECT key FROM api_idempotency WHERE org_id = ?', ['org-b'])).toHaveLength(
      1,
    );
  });

  it.each([
    ['a 63-character request hash', { request_hash: 'a'.repeat(63) }],
    ['an empty principal', { principal_key: '' }],
    ['an oversized principal', { principal_key: 'a'.repeat(81) }],
    ['an empty idempotency key', { key: '' }],
    ['an oversized idempotency key', { key: 'a'.repeat(129) }],
    ['a status below 100', { status: 99 }],
    ['a status above 599', { status: 600 }],
    ['invalid response JSON', { response_json: '{bad' }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(insert('api_idempotency', replay(overrides))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('uses the action index for an organization-scoped audit scan', async () => {
    const plan = await rows<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT seq FROM audit_event WHERE org_id = ? AND action = ? AND seq > ? ORDER BY seq LIMIT 50',
      [ORG, 'project.create', 0],
    );
    expect(plan.map((row) => row.detail).join('\n')).toContain('audit_event_action');
  });

  it('includes pending business data and excludes the replay cache from backups', () => {
    expect(BACKUP_SCOPE.audit_pending).toBe('include');
    expect(BACKUP_SCOPE.api_idempotency).toBe('exclude');
  });
});
