import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { orgContext } from '@package-broker/core/db/port';
import { AUDIT_ALERT_CODES } from '@package-broker/core/audit/health';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createAuditHealthRepository } from '@package-broker/db-sqlite/repositories/audit-health';
import * as auditHealthRepository from '@package-broker/db-sqlite/repositories/audit-health';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { run } from '../cli.js';

let dir: string;
let database: Pick<MigratedDatabase, 'executor' | 'close'>;
let file: string;
let actorId: string;
let orgId: string;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), 'pb-audit-alert-'));
  file = join(dir, 'db.sqlite');
  const migrated = await openMigratedDatabase({ file });
  await migrated.close();
  database = openBetterSqliteExecutor(file);
  orgId = ulid();
  actorId = ulid();
  await createOrganizationBootstrap(database.executor).bootstrap({
    id: orgId,
    slug: 'audit',
    name: 'Audit',
    now: '2026-10-31T00:00:00.000Z',
  });
  await database.executor.all({
    sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    params: [actorId, orgId, 'operator@example.test'],
  });
});
afterEach(async () => {
  await database?.close();
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const args = () => [
  '--sqlite',
  file,
  '--generation',
  '0',
  '--actor-type',
  'user',
  '--actor-id',
  actorId,
];
const command = (...parts: string[]) => run(['audit', 'alert', ...parts, ...args()]);
const rows = (table: string) =>
  database.executor.all({ sql: `SELECT * FROM ${table} WHERE org_id = ?`, params: [orgId] });

it('lists every registered code with only fixed meanings and health state, without writing', async () => {
  await createAuditHealthRepository(database.executor).observe(orgContext(orgId), [
    { code: 'audit.capacity', fingerprint: 'private@example.test', failing: true },
  ]);
  const before = await rows('audit_health');
  expect(await command('list')).toBe(0);
  const output = JSON.parse(vi.mocked(console.log).mock.lastCall![0] as string);
  expect(output.result).toBe('applied');
  expect(
    output.alerts.find((row: { code: string }) => row.code === 'audit.mode_none').meaning,
  ).toBe('No durable audit history is being kept; events are still staged and sealed.');
  expect(output.alerts.map((row: { code: string }) => row.code)).toEqual(AUDIT_ALERT_CODES);
  expect(output.alerts.find((row: { code: string }) => row.code === 'audit.capacity')).toEqual({
    code: 'audit.capacity',
    meaning: 'Audit storage reached a capacity threshold.',
    active: true,
    revision: 1,
    acknowledgedRevision: 0,
  });
  for (const row of output.alerts)
    expect(Object.keys(row)).toEqual([
      'code',
      'meaning',
      'active',
      'revision',
      'acknowledgedRevision',
    ]);
  expect(JSON.stringify(output)).not.toContain('private@example.test');
  expect(await rows('audit_health')).toEqual(before);
  expect(await rows('audit_pending')).toEqual([]);
  expect(await rows('audit_ledger')).toEqual([]);
});
it('acknowledges exactly the current revision and stages one event without a ledger row', async () => {
  const port = createAuditHealthRepository(database.executor);
  await port.raise(orgContext(orgId), 'audit.capacity');
  expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ result: 'applied' }));
  expect((await rows('audit_health'))[0]).toMatchObject({ acknowledged_revision: 1 });
  expect(await rows('audit_pending')).toHaveLength(1);
  expect(await rows('audit_ledger')).toEqual([]);
  await port.raise(orgContext(orgId), 'audit.capacity');
  expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: stale_revision');
  expect(await rows('audit_pending')).toHaveLength(1);
  expect((await rows('audit_health'))[0]).toMatchObject({ revision: 2, acknowledged_revision: 1 });
});
it.each([
  ['ack', 'audit.unknown', '--revision', '1'],
  ['ack', 'audit.capacity'],
  ['ack', 'audit.capacity', '--revision', '1e2'],
  ['ack', 'audit.capacity', '--revision', '-1'],
  ['ack', 'audit.capacity', '--revision', '9007199254740992'],
  ['list', '--revision', '1'],
  ['list', 'extra'],
  ['ack', 'audit.capacity', '--revision', '1', 'extra'],
  ['list', '--cloudflare', '--database-id', 'x'],
])('rejects invalid invocation: %j', async (...parts) => {
  expect(await command(...parts)).toBe(2);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: invalid_input');
  expect(await rows('audit_pending')).toEqual([]);
});
it('refuses absent or already acknowledged revisions by name', async () => {
  expect(await command('ack', 'audit.capacity', '--revision', '0')).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: stale_revision');
  await createAuditHealthRepository(database.executor).raise(orgContext(orgId), 'audit.capacity');
  expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(0);
  expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: stale_revision');
  expect(await rows('audit_pending')).toHaveLength(1);
});
it('requires an active organization actor and never echoes invalid actor input', async () => {
  expect(
    await run(['audit', 'alert', 'list', ...args().slice(0, -1), 'private@example.test']),
  ).toBe(2);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: invalid_input');
  expect(await run(['audit', 'alert', 'list', ...args().slice(0, -1), ulid()])).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: actor_unavailable');
  await database.executor.all({
    sql: "UPDATE user_account SET status = 'suspended' WHERE org_id = ? AND id = ?",
    params: [orgId, actorId],
  });
  expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: actor_unavailable');
});
it('accepts active service principals and follows generation exit conventions', async () => {
  await database.executor.all({
    sql: 'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
    params: [actorId, orgId, 'Operator', actorId],
  });
  const serviceArgs = [
    '--sqlite',
    file,
    '--generation',
    '0',
    '--actor-type',
    'service_principal',
    '--actor-id',
    actorId,
  ];
  expect(await run(['audit', 'alert', 'list', ...serviceArgs])).toBe(0);
  await createAuditHealthRepository(database.executor).raise(orgContext(orgId), 'audit.capacity');
  expect(
    await run(['audit', 'alert', 'ack', 'audit.capacity', '--revision', '1', ...serviceArgs]),
  ).toBe(0);
  expect((await rows('audit_pending'))[0]).toMatchObject({
    actor_type: 'service_principal',
    actor_id: actorId,
  });
  expect(
    await run([
      'audit',
      'alert',
      'list',
      '--sqlite',
      file,
      '--generation',
      '1',
      '--actor-type',
      'user',
      '--actor-id',
      actorId,
    ]),
  ).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit alert: generation_ahead');
});

it('returns the sink administration stale-generation status without writing', async () => {
  await database.executor.all({
    sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, created_at, updated_at)
      VALUES (?, 'sink', 'sink', 'webhook', 1, 'fingerprint', 1, 'build', 'active', 0, ?, 0, 'now', 'now')`,
    params: [orgId, '0'.repeat(64)],
  });
  expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(6);
  expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ result: 'stale' }));
  expect(await rows('audit_pending')).toEqual([]);
});

it.each(['generation', 'operator'])(
  'reports contention when %s changes after preflight',
  async (change) => {
    await database.executor.all({
      sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, created_at, updated_at)
      VALUES (?, 'sink', 'sink', 'webhook', 0, 'fingerprint', 1, 'build', 'active', 0, ?, 0, 'now', 'now')`,
      params: [orgId, '0'.repeat(64)],
    });
    await createAuditHealthRepository(database.executor).raise(orgContext(orgId), 'audit.capacity');
    const before = await rows('audit_health');
    const createRepository = auditHealthRepository.createAuditHealthRepository;
    const preflight = vi.fn();
    vi.spyOn(auditHealthRepository, 'createAuditHealthRepository').mockImplementation((...args) => {
      const port = createRepository(...args);
      return {
        ...port,
        async operatorStatus(ctx) {
          const status = await port.operatorStatus(ctx);
          preflight(status);
          if (change === 'generation') {
            await database.executor.all({
              sql: 'UPDATE audit_sink SET generation = 1 WHERE org_id = ? AND sink_id = ?',
              params: [orgId, 'sink'],
            });
          } else {
            await database.executor.all({
              sql: "UPDATE user_account SET status = 'suspended' WHERE org_id = ? AND id = ?",
              params: [orgId, actorId],
            });
          }
          return status;
        },
      };
    });
    expect(await command('ack', 'audit.capacity', '--revision', '1')).toBe(6);
    expect(preflight).toHaveBeenCalledExactlyOnceWith('ready');
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ result: 'contended' }));
    expect(console.error).not.toHaveBeenCalled();
    expect(await rows('audit_health')).toEqual(before);
    expect(await rows('audit_pending')).toEqual([]);
    expect(await rows('audit_ledger')).toEqual([]);
  },
);
