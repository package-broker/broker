import { mkdtemp, readFile, rm, writeFile, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createAuditLedgerRepository } from '@package-broker/db-sqlite/repositories/audit-ledger';
import { DbError, type DbErrorKind } from '@package-broker/core/db/errors';
import { orgContext } from '@package-broker/core/db/port';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import * as sqliteDriver from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { collectMigrations, defaultResolvePackageDir } from '../migrations-collect.js';
import { fileURLToPath } from 'node:url';
import { ulid } from '@package-broker/core/ids';
import { run } from '../cli.js';
import { runRestoreSqlite, runAuditEpochBump } from './sqlite.js';
import type { Statement, ScalarStatement } from '@package-broker/core/db/port';

import { exportSnapshot, type SnapshotStatement } from './fixtures/sqlite-exporter.js';

let dir: string;
let file: string;
let snapshot: string;
let orgId: string;
const now = '2026-10-30T00:00:00.000Z';

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), 'pb-restore-'));
  file = join(dir, 'restored.sqlite');
  snapshot = join(dir, 'snapshot.json');
  const source = await openMigratedDatabase();
  try {
    orgId = ulid();
    await createOrganizationBootstrap(source.executor).bootstrap({
      id: orgId,
      slug: 'restore',
      name: 'Restore',
      now,
    });
    await source.executor.batch([
      {
        sql: 'UPDATE audit_chain SET epoch = 3, incarnation = 7 WHERE org_id = ?',
        params: [orgId],
      },
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
        durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq,
        inflight_from, inflight_to, inflight_body, inflight_repr)
        VALUES (?, 'webhook', 'webhook', 'webhook', 1, 'receiver', 1, 'env', 'active', 0, ?, 0, 1, 1, '{}', '{"custodyStart":0}')`,
        params: [orgId, '0'.repeat(64)],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
        reason_code, policy, mode_generation, actor_type, created_at)
        SELECT org_id, ?, 'gap', chain_id, epoch, 1, 1, 1, 'test_gap', policy, mode_generation, 'system', ?
        FROM audit_chain WHERE org_id = ?`,
        params: [ulid(), now, orgId],
      },
    ]);
    const ledger = createAuditLedgerRepository(source.executor);
    const [first] = await ledger.page(orgContext(orgId), null, 10);
    await ledger.append(orgContext(orgId), [{ ...first!, id: ulid(), fromSeq: 2, toSeq: 2 }]);
    const statements = await exportSnapshot(source.executor);
    // Exercise historical superseded ledger rows that insert triggers refuse.
    const ledgerInsert = statements.find(({ sql }) => sql.startsWith('INSERT INTO "audit_ledger"'));
    expect(ledgerInsert).toBeDefined();
    await writeFile(snapshot, JSON.stringify(statements));
  } finally {
    await source.close();
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('restores tables, rows and triggers, then marks and blocks before publication', async () => {
  expect(await run(['sqlite', 'restore', '--sqlite', file, '--snapshot', snapshot])).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    expect(
      await opened.executor.all({
        sql: 'SELECT epoch, incarnation, restore_pending FROM audit_chain WHERE org_id = ?',
        params: [orgId],
      }),
    ).toEqual([{ epoch: 4, incarnation: 8, restore_pending: 1 }]);
    expect(
      await opened.executor.all({
        sql: 'SELECT state, blocked_reason, inflight_body, inflight_repr FROM audit_sink WHERE org_id = ?',
        params: [orgId],
      }),
    ).toEqual([
      {
        state: 'blocked',
        blocked_reason: 'fork',
        inflight_body: '{}',
        inflight_repr: '{"custodyStart":0}',
      },
    ]);
    expect(
      await opened.executor.all({
        sql: 'SELECT kind FROM audit_ledger WHERE org_id = ? ORDER BY kind',
        params: [orgId],
      }),
    ).toEqual([{ kind: 'epoch_bump' }, { kind: 'gap' }, { kind: 'gap' }]);
    const events = await opened.executor.all<{ action: string; payload_json: string }>({
      sql: 'SELECT action, payload_json FROM audit_pending WHERE org_id = ?',
      params: [orgId],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('audit.sink_admin');
    expect(JSON.parse(events[0]!.payload_json).changes.operation.new).toBe('epoch_bump');
    await expect(
      opened.executor.all({ sql: 'DELETE FROM audit_ledger WHERE org_id = ?', params: [orgId] }),
    ).rejects.toThrow('append-only');
    expect(await opened.executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).toEqual([]);
  } finally {
    await opened.close();
  }
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
});

it('bumps the epoch after a manual restore and never creates a missing SQLite file', async () => {
  expect(await run(['audit', 'epoch', 'bump', '--sqlite', file])).toBe(2);
  await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  expect(await run(['audit', 'epoch', 'bump', '--sqlite', file])).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    expect(
      await opened.executor.all({
        sql: 'SELECT epoch, incarnation, restore_pending FROM audit_chain WHERE org_id = ?',
        params: [orgId],
      }),
    ).toEqual([{ epoch: 5, incarnation: 9, restore_pending: 1 }]);
    expect(
      await opened.executor.all({
        sql: "SELECT count(*) AS n FROM audit_ledger WHERE org_id = ? AND kind = 'epoch_bump'",
        params: [orgId],
      }),
    ).toEqual([{ n: 2 }]);
  } finally {
    await opened.close();
  }
});

it('carries recorded seq gaps of the retained window into the bumped epoch', async () => {
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    await opened.executor.batch([
      { sql: 'UPDATE audit_chain SET head_seq = 6 WHERE org_id = ?', params: [orgId] },
      ...(
        [
          [3, 3, null],
          [5, 5, 'webhook'],
        ] as const
      ).map(([from, to, sinkId]) => ({
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
        sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT org_id, ?, 'gap', chain_id, epoch, ?, ?, 1, ?, 'seq_gap', policy, mode_generation, 'system', ?
        FROM audit_chain WHERE org_id = ?`,
        params: [ulid(), from, to, sinkId, now, orgId],
      })),
    ]);
  } finally {
    await opened.close();
  }
  expect(await run(['audit', 'epoch', 'bump', '--sqlite', file])).toBe(0);
  const reopened = openBetterSqliteExecutor(file);
  try {
    expect(
      await reopened.executor.all({
        sql: `SELECT epoch, from_seq, to_seq, count, sink_id FROM audit_ledger
        WHERE org_id = ? AND reason_code = 'seq_gap' ORDER BY epoch, from_seq`,
        params: [orgId],
      }),
    ).toEqual([
      { epoch: 4, from_seq: 3, to_seq: 3, count: 1, sink_id: null },
      { epoch: 4, from_seq: 5, to_seq: 5, count: 1, sink_id: 'webhook' },
      { epoch: 5, from_seq: 3, to_seq: 3, count: 1, sink_id: null },
    ]);
  } finally {
    await reopened.close();
  }
});

it.each(['', '-wal', '-shm', '-journal'])(
  'refuses an existing target%s without altering it',
  async (suffix) => {
    const bytes = 'existing target';
    await writeFile(file + suffix, bytes);
    expect(await runRestoreSqlite({ file, snapshot })).toBe(1);
    expect(vi.mocked(console.error).mock.calls).toEqual([['SqliteRestoreError: target_exists']]);
    expect(await readFile(file + suffix, 'utf8')).toBe(bytes);
    if (suffix) await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('refuses unbundled trigger SQL and removes no existing data', async () => {
  const statements = JSON.parse(await readFile(snapshot, 'utf8'));
  statements.push({
    sql: `CREATE TRIGGER refuse_restore BEFORE UPDATE ON audit_chain BEGIN SELECT RAISE(ABORT, 'private snapshot diagnostic'); END`,
    params: [],
  });
  await writeFile(snapshot, JSON.stringify(statements));
  expect(await runRestoreSqlite({ file, snapshot })).toBe(1);
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    'private snapshot diagnostic',
  );
});

it.each([
  ['sqlite', 'restore', '--sqlite', 'target'],
  ['audit', 'epoch', 'bump'],
  ['audit', 'epoch', 'bump', '--sqlite', 'target', '--cloudflare'],
  ['audit', 'epoch', 'bump', '--sqlite', 'target', '--snapshot', 'backup'],
  ['audit', 'epoch', 'bump', 'extra', '--sqlite', 'target'],
])('rejects invalid arguments %j', async (...args) => {
  expect(await run(args)).toBe(2);
});

it.each([false, true])(
  'uses one atomic D1 control batch and rolls back a stale snapshot (race=%s)',
  async (race) => {
    expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
    const opened = openBetterSqliteExecutor(file);
    const batches: ScalarStatement[][] = [];
    const send: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.batch) {
        batches.push(request.batch);
        if (race)
          await opened.executor.all({
            sql: 'UPDATE audit_chain SET incarnation = incarnation + 1 WHERE org_id = ?',
            params: [orgId],
          });
      }
      try {
        const results = await opened.executor.batch(
          request.batch ?? [{ sql: request.sql, params: request.params }],
        );
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: results.map(({ rows, changes }) => ({
            success: true,
            results: rows,
            meta: { changes },
          })),
        });
      } catch {
        return Response.json(
          {
            success: false,
            errors: [
              { code: 7500, message: 'UNIQUE constraint failed: access_mutation_guard.key' },
            ],
            messages: [],
            result: [],
          },
          { status: 400 },
        );
      }
    };
    try {
      expect(
        await runAuditEpochBump({
          target: {
            kind: 'cloudflare',
            databaseId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            env: { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-token' },
            fetch: send,
          },
        }),
      ).toBe(race ? 1 : 0);
      if (race)
        expect(vi.mocked(console.error).mock.calls.at(-1)).toEqual([
          'AuditEpochBumpError: concurrent_change',
        ]);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.length).toBeLessThanOrEqual(200);
      expect(batches[0]!.every(({ params }) => params.length <= 100)).toBe(true);
      expect(
        await opened.executor.all({
          sql: 'SELECT epoch, incarnation FROM audit_chain WHERE org_id = ?',
          params: [orgId],
        }),
      ).toEqual([{ epoch: race ? 4 : 5, incarnation: 9 }]);
      expect(
        await opened.executor.all({
          sql: "SELECT count(*) AS n FROM audit_ledger WHERE org_id = ? AND kind = 'epoch_bump'",
          params: [orgId],
        }),
      ).toEqual([{ n: race ? 1 : 2 }]);
      expect(
        await opened.executor.all({
          sql: 'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
          params: [orgId],
        }),
      ).toEqual([{ n: race ? 1 : 2 }]);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
        /private-token|private diagnostic/,
      );
    } finally {
      await opened.close();
    }
  },
);

it('restores more than 200 statements in one transaction and keeps binary values', async () => {
  const statements = JSON.parse(await readFile(snapshot, 'utf8'));
  for (let i = 0; i < 205; i++)
    statements.push({
      sql: "INSERT INTO credential (org_id, id, ciphertext, nonce, created_at, kind, key_version, aad) VALUES (?, ?, ?, ?, ?, 'test', 1, 'test')",
      params: [orgId, `bytes-${i}`, { hex: '00ff80' }, { hex: '00'.repeat(12) }, now],
    });
  await writeFile(snapshot, JSON.stringify(statements));
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    expect(
      await opened.executor.all({
        sql: 'SELECT count(*) AS n, hex(ciphertext) AS value FROM credential WHERE org_id = ? GROUP BY ciphertext',
        params: [orgId],
      }),
    ).toEqual([{ n: 205, value: '00FF80' }]);
  } finally {
    await opened.close();
  }
});

it('rolls back an exhausted incarnation with no partial ledger or pending event', async () => {
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    await opened.executor.all({
      sql: 'UPDATE audit_chain SET incarnation = ? WHERE org_id = ?',
      params: [Number.MAX_SAFE_INTEGER, orgId],
    });
    expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(1);
    expect(
      await opened.executor.all({
        sql: 'SELECT epoch, incarnation FROM audit_chain WHERE org_id = ?',
        params: [orgId],
      }),
    ).toEqual([{ epoch: 4, incarnation: Number.MAX_SAFE_INTEGER }]);
    expect(
      await opened.executor.all({
        sql: "SELECT count(*) AS n FROM audit_ledger WHERE org_id = ? AND kind = 'epoch_bump'",
        params: [orgId],
      }),
    ).toEqual([{ n: 1 }]);
  } finally {
    await opened.close();
  }
});

it('marks every organization on restore and on a later epoch bump', async () => {
  const { outDir, sources } = await fixtureBuild(
    '-- pb:phase contract\nDROP INDEX IF EXISTS organization_singleton;',
  );
  const source = await openMigratedDatabase({ twoOrganizations: true });
  const a = source.orgs!.a.orgId;
  const b = source.orgs!.b.orgId;
  try {
    await migrate(source.executor, sources, { holder: ulid() });
    await writeFile(snapshot, JSON.stringify(await exportSnapshot(source.executor)));
  } finally {
    await source.close();
  }
  expect(await runRestoreSqlite({ file, snapshot, outDir })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    for (const id of [a, b]) {
      expect(
        await opened.executor.all({
          sql: 'SELECT epoch, incarnation, restore_pending FROM audit_chain WHERE org_id = ?',
          params: [id],
        }),
      ).toEqual([{ epoch: 1, incarnation: 1, restore_pending: 1 }]);
      expect(
        await opened.executor.all({
          sql: 'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
          params: [id],
        }),
      ).toEqual([{ n: 1 }]);
    }
    expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(0);
    for (const id of [a, b]) {
      const expected = 2;
      expect(
        await opened.executor.all({
          sql: 'SELECT epoch, incarnation FROM audit_chain WHERE org_id = ?',
          params: [id],
        }),
      ).toEqual([{ epoch: expected, incarnation: expected }]);
      expect(
        await opened.executor.all({
          sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
          params: [id],
        }),
      ).toEqual([{ n: expected }]);
    }
  } finally {
    await opened.close();
  }
});

it('round-trips the real exporter format, including hex text and multi-row inserts', async () => {
  const statements = JSON.parse(await readFile(snapshot, 'utf8'));
  expect(statements[0]).toEqual({ sql: 'PRAGMA defer_foreign_keys = ON', params: [] });
  expect(statements.some(({ sql }: { sql: string }) => sql.includes('CAST(? AS TEXT)'))).toBe(true);
  expect(statements.some(({ sql }: { sql: string }) => /\),\(/.test(sql))).toBe(true);
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    expect(
      await opened.executor.all({
        sql: 'SELECT slug, name, typeof(name) AS type FROM organization WHERE id = ?',
        params: [orgId],
      }),
    ).toEqual([{ slug: 'restore', name: 'Restore', type: 'text' }]);
  } finally {
    await opened.close();
  }
});

it('blocks only active/blocked sinks and preserves existing reasons and untouched timestamps', async () => {
  const statements = JSON.parse(await readFile(snapshot, 'utf8'));
  const states = ['active', 'blocked', 'retired', 'disabled', 'inactive'];
  for (const state of states)
    statements.push({
      sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
      receiver_fingerprint, durable_ack, activation_source, state, progress_seq,
      progress_hash, custody_seq, blocked_reason, updated_at)
      VALUES (?, ?, 'webhook', 'webhook', 1, 'receiver', 1, 'env', ?, 0, ?, 0, ?, ?)`,
      params: [orgId, state, state, '0'.repeat(64), 'existing_reason', now],
    });
  await writeFile(snapshot, JSON.stringify(statements));
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    for (const state of states) {
      const [sink] = await opened.executor.all<{
        state: string;
        blocked_reason: string;
        updated_at: string;
      }>({
        sql: 'SELECT state, blocked_reason, updated_at FROM audit_sink WHERE org_id = ? AND sink_id = ?',
        params: [orgId, state],
      });
      expect(sink?.state).toBe(['active', 'blocked'].includes(state) ? 'blocked' : state);
      expect(sink?.blocked_reason).toBe('existing_reason');
      if (!['active', 'blocked'].includes(state)) expect(sink?.updated_at).toBe(now);
    }
  } finally {
    await opened.close();
  }
});

it.each([
  'schema-only',
  'no-organization',
  'migration-id',
  'migration-checksum',
  'missing-migration',
  'extra-migration',
  'view',
  'chain',
  'fk',
  'missing-ledger-trigger',
  'altered-check',
  'tightened-check',
  'missing-table',
  'extra-table',
  'missing-index',
  'nbsp-column',
  'cr-trigger-comment',
])('refuses %s snapshots with a fixed reason and removes the new target', async (variant) => {
  let statements = JSON.parse(await readFile(snapshot, 'utf8')) as SnapshotStatement[];
  let reason = 'invalid_snapshot';
  if (variant === 'schema-only')
    statements = statements.filter(({ sql }) => !sql.startsWith('INSERT'));
  if (variant === 'no-organization')
    statements = statements.filter(({ sql }) => !sql.startsWith('INSERT INTO "organization"'));
  if (variant.startsWith('migration') || variant.endsWith('migration')) {
    reason = 'migration_mismatch';
    const migration = statements.find(({ sql }) =>
      sql.startsWith('INSERT INTO "schema_migration"'),
    )!;
    if (variant === 'missing-migration')
      statements = statements.filter((statement) => statement !== migration);
    else if (variant === 'extra-migration')
      statements.push({
        sql: 'INSERT INTO schema_migration (id, name, checksum) VALUES (?, ?, ?)',
        params: ['extra', 'extra', 'a'.repeat(64)],
      });
    else
      migration.params[variant === 'migration-id' ? 0 : 2] = {
        hex: Buffer.from(variant === 'migration-id' ? 'private mismatch' : 'a'.repeat(64)).toString(
          'hex',
        ),
      };
  }
  if (variant === 'view') {
    reason = 'migration_mismatch';
    statements.push({ sql: 'CREATE VIEW private_view AS SELECT 1', params: [] });
  }
  if (variant === 'chain') {
    statements = statements.filter(
      ({ sql }) => !/^INSERT INTO "audit_(chain|sink|ledger)"/.test(sql),
    );
    reason = 'chain_missing';
  }
  if (variant === 'fk') {
    statements.push({
      sql: "INSERT INTO credential (org_id, id, ciphertext, nonce, created_at, kind, key_version, aad) VALUES (?, ?, ?, ?, ?, 'test', 1, 'test')",
      params: ['private orphan', 'orphan', { hex: '00' }, { hex: '00'.repeat(12) }, now],
    });
    reason = 'fk_violation';
  }
  if (variant === 'missing-ledger-trigger') {
    const trigger = statements.find(({ sql }) => /^CREATE TRIGGER audit_ledger/i.test(sql))!;
    expect(trigger).toBeDefined();
    statements = statements.filter((statement) => statement !== trigger);
    reason = 'migration_mismatch';
  }
  if (variant === 'altered-check' || variant === 'tightened-check') {
    const table = statements.find(({ sql }) => /^CREATE TABLE credential /i.test(sql))!;
    expect(table.sql).toContain('length(nonce) = 12');
    table.sql = table.sql.replace(
      'length(nonce) = 12',
      variant === 'altered-check' ? 'length(nonce) >= 1' : 'length(nonce) = 1',
    );
    reason = 'migration_mismatch';
  }
  if (variant === 'missing-table') {
    statements = statements.filter(({ sql }) => !/^CREATE TABLE credential /i.test(sql));
    statements.push({ sql: "INSERT INTO credential (id) VALUES ('missing')", params: [] });
    reason = 'migration_mismatch';
  }
  if (variant === 'extra-table') {
    statements.push({ sql: 'CREATE TABLE restore_bytes (value BLOB)', params: [] });
    reason = 'migration_mismatch';
  }
  if (variant === 'nbsp-column') {
    const table = statements.find(({ sql }) => /^CREATE TABLE credential /i.test(sql))!;
    expect(table.sql).toMatch(/nonce +BLOB/);
    table.sql = table.sql.replace(/nonce /, 'nonce\u00a0');
    reason = 'migration_mismatch';
  }
  if (variant === 'cr-trigger-comment') {
    const trigger = statements.find(({ sql }) => /^CREATE TRIGGER audit_ledger/i.test(sql))!;
    expect(trigger.sql).toContain('BEGIN');
    trigger.sql = trigger.sql.replace('BEGIN', 'BEGIN -- comment\r');
    reason = 'migration_mismatch';
  }
  if (variant === 'missing-index') {
    const index = statements.find(({ sql }) => /^CREATE INDEX /i.test(sql))!;
    expect(index).toBeDefined();
    statements = statements.filter((statement) => statement !== index);
    reason = 'migration_mismatch';
  }
  await writeFile(snapshot, JSON.stringify(statements));
  expect(await runRestoreSqlite({ file, snapshot })).toBe(1);
  expect(vi.mocked(console.error).mock.calls).toEqual([[`SqliteRestoreError: ${reason}`]]);
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('records an empty-chain epoch bump at [1,1] with zero count without advancing the head', async () => {
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    expect(
      await opened.executor.all({
        sql: "SELECT from_seq, to_seq, count FROM audit_ledger WHERE org_id = ? AND kind = 'epoch_bump'",
        params: [orgId],
      }),
    ).toEqual([{ from_seq: 1, to_seq: 1, count: 0 }]);
    expect(
      await opened.executor.all({
        sql: 'SELECT head_seq FROM audit_chain WHERE org_id = ?',
        params: [orgId],
      }),
    ).toEqual([{ head_seq: 0 }]);
  } finally {
    await opened.close();
  }
});

async function fixtureBuild(
  sql: string,
): Promise<{ outDir: string; sources: Awaited<ReturnType<typeof collectMigrations>> }> {
  const outDir = join(dir, 'build');
  const sources = await collectMigrations(
    [],
    defaultResolvePackageDir(fileURLToPath(new URL('../', import.meta.url))),
  );
  const plugin = await loadMigrationSource('fixture', '0001_plugin.sql', sql);
  sources.push(plugin);
  await mkdir(join(outDir, 'generated'), { recursive: true });
  for (const source of sources) {
    await mkdir(join(outDir, 'migrations', source.owner), { recursive: true });
    await writeFile(join(outDir, 'migrations', source.owner, source.name + '.sql'), source.sql);
  }
  await writeFile(
    join(outDir, 'generated', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      migrations: sources.map(({ id, name, checksum, phase }) => ({
        id,
        name: name + '.sql',
        checksum,
        phase,
      })),
    }),
  );
  return { outDir, sources };
}

it.each([false, true])('uses plugin migrations only with --out (build=%s)', async (withBuild) => {
  const { outDir, sources } = await fixtureBuild(
    'CREATE TABLE plugin_fixture (org_id TEXT REFERENCES organization(id), value TEXT);',
  );
  const source = await openMigratedDatabase();
  try {
    await migrate(source.executor, sources, { holder: ulid() });
    await createOrganizationBootstrap(source.executor).bootstrap({
      id: orgId,
      slug: 'plugin',
      name: 'Plugin',
      now,
    });
    await source.executor.all({
      sql: 'INSERT INTO plugin_fixture VALUES (?, ?)',
      params: [orgId, 'preserved'],
    });
    await writeFile(snapshot, JSON.stringify(await exportSnapshot(source.executor)));
  } finally {
    await source.close();
  }
  expect(
    await run([
      'sqlite',
      'restore',
      '--sqlite',
      file,
      '--snapshot',
      snapshot,
      ...(withBuild ? ['--out', outDir] : []),
    ]),
  ).toBe(withBuild ? 0 : 1);
  if (!withBuild) {
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['SqliteRestoreError: migration_mismatch'],
    ]);
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    const opened = openBetterSqliteExecutor(file);
    try {
      expect(
        await opened.executor.all({
          sql: 'SELECT value FROM plugin_fixture WHERE org_id = ?',
          params: [orgId],
        }),
      ).toEqual([{ value: 'preserved' }]);
    } finally {
      await opened.close();
    }
  }
});

it('rolls back every organization when the second organization control fails', async () => {
  const { outDir, sources } = await fixtureBuild(
    '-- pb:phase contract\nDROP INDEX IF EXISTS organization_singleton;',
  );
  const source = await openMigratedDatabase({ twoOrganizations: true });
  const a = source.orgs!.a.orgId;
  const b = source.orgs!.b.orgId;
  try {
    await migrate(source.executor, sources, { holder: ulid() });
    await writeFile(snapshot, JSON.stringify(await exportSnapshot(source.executor)));
  } finally {
    await source.close();
  }
  expect(await runRestoreSqlite({ file, snapshot, outDir })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    await opened.executor.all({
      sql: 'UPDATE audit_chain SET incarnation = ? WHERE org_id = ?',
      params: [Number.MAX_SAFE_INTEGER, b],
    });
    const before = await opened.executor.all({
      sql: 'SELECT * FROM audit_chain WHERE org_id IN (?, ?) ORDER BY org_id',
      params: [a, b],
    });
    expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(1);
    expect(vi.mocked(console.error).mock.calls.at(-1)).toEqual([
      'AuditEpochBumpError: concurrent_change',
    ]);
    expect(
      await opened.executor.all({
        sql: 'SELECT * FROM audit_chain WHERE org_id IN (?, ?) ORDER BY org_id',
        params: [a, b],
      }),
    ).toEqual(before);
    for (const id of [a, b]) {
      expect(
        await opened.executor.all({
          sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
          params: [id],
        }),
      ).toEqual([{ n: 1 }]);
      expect(
        await opened.executor.all({
          sql: 'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
          params: [id],
        }),
      ).toEqual([{ n: 1 }]);
    }
  } finally {
    await opened.close();
  }
});

it('refuses oversized deployment control batches before any writes', async () => {
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  try {
    await opened.executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
    for (let i = 0; i < 50; i++)
      await opened.executor.all({
        sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
        params: [ulid(), `org-${i}`, 'Fixture'],
      });
    const before = await opened.executor.all({
      sql: 'SELECT * FROM audit_chain ORDER BY org_id',
      params: [],
    });
    expect(before.length).toBeGreaterThan(40);
    expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(1);
    expect(vi.mocked(console.error).mock.calls.at(-1)).toEqual([
      'AuditEpochBumpError: batch_limit',
    ]);
    expect(
      await opened.executor.all({ sql: 'SELECT * FROM audit_chain ORDER BY org_id', params: [] }),
    ).toEqual(before);
  } finally {
    await opened.close();
  }
});

it('reports missing snapshot and inaccessible destination as io_error', async () => {
  for (const options of [
    { file, snapshot: join(dir, 'missing.json') },
    { file: join(dir, 'missing', 'target.sqlite'), snapshot },
  ]) {
    expect(await runRestoreSqlite(options)).toBe(1);
    expect(vi.mocked(console.error).mock.calls.at(-1)).toEqual(['SqliteRestoreError: io_error']);
  }
});

it('preserves migration_mismatch when rollback also throws', async () => {
  const statements: SnapshotStatement[] = JSON.parse(await readFile(snapshot, 'utf8'));
  statements.push({ sql: 'CREATE TABLE extra (id INTEGER)', params: [] });
  await writeFile(snapshot, JSON.stringify(statements));
  const originalOpen = sqliteDriver.openBetterSqliteExecutor;
  let rollback = false;
  vi.spyOn(sqliteDriver, 'openBetterSqliteExecutor').mockImplementation((path, options) => {
    const opened = originalOpen(path, options);
    if (path === file) {
      const originalAll = opened.executor.all.bind(opened.executor);
      opened.executor.all = async <R>(statement: Statement): Promise<R[]> => {
        if (statement.sql === 'ROLLBACK') {
          rollback = true;
          throw new Error('private rollback failure');
        }
        return originalAll<R>(statement);
      };
    }
    return opened;
  });
  expect(await runRestoreSqlite({ file, snapshot })).toBe(1);
  expect(rollback).toBe(true);
  expect(vi.mocked(console.error).mock.calls).toEqual([['SqliteRestoreError: migration_mismatch']]);
});

it('reports an unexpected control failure as internal', async () => {
  expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
  const originalOpen = sqliteDriver.openBetterSqliteExecutor;
  vi.spyOn(sqliteDriver, 'openBetterSqliteExecutor').mockImplementation((path, options) => {
    const opened = originalOpen(path, options);
    opened.executor.batch = async () => {
      throw new Error('private unexpected failure');
    };
    return opened;
  });
  expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(1);
  expect(vi.mocked(console.error).mock.calls.at(-1)).toEqual(['AuditEpochBumpError: internal']);
});

it('creates private WAL/SHM sidecars and restores the caller umask', async () => {
  const originalOpen = sqliteDriver.openBetterSqliteExecutor;
  const previous = process.umask(0o022);
  const checked: string[] = [];
  try {
    vi.spyOn(sqliteDriver, 'openBetterSqliteExecutor').mockImplementation((path, options) => {
      const opened = originalOpen(path, options);
      if (path === file) {
        const originalAll = opened.executor.all.bind(opened.executor);
        opened.executor.all = async <R>(statement: Statement): Promise<R[]> => {
          const rows = await originalAll<R>(statement);
          if (statement.sql === 'BEGIN IMMEDIATE') {
            for (const suffix of ['-wal', '-shm']) {
              expect((await lstat(file + suffix)).mode & 0o777).toBe(0o600);
              checked.push(suffix);
            }
          }
          return rows;
        };
      }
      return opened;
    });
    expect(await runRestoreSqlite({ file, snapshot })).toBe(0);
    expect(checked).toEqual(['-wal', '-shm']);
    expect(process.umask()).toBe(0o022);
  } finally {
    process.umask(previous);
  }
});

it('reports chain_missing when an epoch bump has no organization', async () => {
  const source = await openMigratedDatabase({ file });
  await source.close();
  expect(await runAuditEpochBump({ target: { kind: 'sqlite', file } })).toBe(1);
  expect(vi.mocked(console.error).mock.calls).toEqual([['AuditEpochBumpError: chain_missing']]);
});

it.each<[DbErrorKind, string]>([
  ['check', 'invalid_snapshot'],
  ['unique', 'invalid_snapshot'],
  ['not_null', 'invalid_snapshot'],
  ['busy', 'concurrent_change'],
  ['unknown', 'internal'],
  ['too_big', 'internal'],
  ['foreign_key', 'fk_violation'],
])('classifies a rows-phase %s error as %s', async (kind, reason) => {
  const originalOpen = sqliteDriver.openBetterSqliteExecutor;
  let injected = false;
  vi.spyOn(sqliteDriver, 'openBetterSqliteExecutor').mockImplementation((path, options) => {
    const opened = originalOpen(path, options);
    if (path === file) {
      const originalAll = opened.executor.all.bind(opened.executor);
      opened.executor.all = async <R>(statement: Statement): Promise<R[]> => {
        if (/^INSERT INTO/i.test(statement.sql)) {
          injected = true;
          throw new DbError(kind, 'private row failure');
        }
        return originalAll<R>(statement);
      };
    }
    return opened;
  });
  expect(await runRestoreSqlite({ file, snapshot })).toBe(1);
  expect(injected).toBe(true);
  expect(vi.mocked(console.error).mock.calls).toEqual([[`SqliteRestoreError: ${reason}`]]);
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' });
});
