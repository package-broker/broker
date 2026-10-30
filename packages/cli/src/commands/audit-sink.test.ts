import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { orgContext } from '@package-broker/core/db/port';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createAuditForkRepository } from '@package-broker/db-sqlite/repositories/audit-fork';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { run } from '../cli.js';

let dir: string;
let database: MigratedDatabase;
let file: string;
let actorId: string;
let orgId: string;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), 'pb-audit-admin-'));
  file = join(dir, 'db.sqlite');
  database = await openMigratedDatabase({ file });
  orgId = ulid();
  actorId = ulid();
  await createOrganizationBootstrap(database.executor).bootstrap({
    id: orgId,
    slug: 'audit',
    name: 'Audit',
    now: '2026-10-30T00:00:00.000Z',
  });
  await database.executor.batch([
    {
      sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      params: [actorId, orgId, 'operator@example.test'],
    },
  ]);
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
it('keeps list read-only and audits only a changed policy', async () => {
  expect(await run(['audit', 'sink', 'list', ...args()])).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ result: 'applied', sinks: [] }));
  expect(await run(['audit', 'policy', 'set', 'required', ...args()])).toBe(0);
  const state = await createAuditForkRepository(database.executor).read(orgContext(orgId));
  expect(state).toMatchObject({ policy: 'required', modeGeneration: 1 });
  const rows = await database.executor.all({
    sql: 'SELECT actor_id, kind FROM audit_ledger WHERE org_id = ? ORDER BY id',
    params: [orgId],
  });
  expect(rows).toEqual([{ actor_id: actorId, kind: 'policy_change' }]);
  expect(
    await database.executor.all({
      sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
      params: [orgId],
    }),
  ).toEqual([{ action: 'audit.sink_admin' }]);
});
it.each([
  ['sink', 'list', '--from', '1'],
  ['sink', 'replay', 'archive', '--from', '1e2'],
  ['sink', 'skip', 'archive', '--seq', '0'],
  ['sink', 'retire', 'archive'],
  ['sink', 'confirm-restore', '--from', '-1'],
  ['policy', 'set', 'unknown'],
  ['sink', 'list', 'extra'],
  ['sink', 'list', '--cloudflare', '--database-id', 'x'],
])('rejects invalid invocation without changing audit state: %j', async (...command) => {
  expect(await run(['audit', ...command, ...args()])).toBe(2);
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
      params: [orgId],
    }),
  ).toEqual([]);
});
it('does not echo malformed actors or database error details', async () => {
  expect(await run(['audit', 'sink', 'list', ...args().slice(0, -1), 'private@example.test'])).toBe(
    2,
  );
  expect(console.error).toHaveBeenLastCalledWith('audit sink: invalid_input');
  expect(console.log).not.toHaveBeenCalled();
});

it('writes nothing for an unchanged policy', async () => {
  expect(await run(['audit', 'policy', 'set', 'availability', ...args()])).toBe(0);
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
      params: [orgId],
    }),
  ).toEqual([]);
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
      params: [orgId],
    }),
  ).toEqual([]);
});
it('prints a fixed refusal code for an unknown actor', async () => {
  expect(await run(['audit', 'sink', 'list', ...args().slice(0, -1), ulid()])).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit sink: actor_unavailable');
});
it('reports confirm-restore limits through observability and prints the fixed reason', async () => {
  await database.executor.batch([
    {
      sql: 'UPDATE audit_chain SET head_seq = 2048, restore_pending = 1 WHERE org_id = ?',
      params: [orgId],
    },
    {
      sql: `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 1024)
      INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
      SELECT 'gap-' || n, org_id, 'gap', chain_id, epoch, 2 * n, 2 * n, 1, 'seq_gap', policy, mode_generation, 'system', ? FROM audit_chain, ids WHERE org_id = ?`,
      params: ['2026-10-30T00:00:00.000Z', orgId],
    },
  ]);
  expect(await run(['audit', 'sink', 'confirm-restore', '--from', '1', ...args()])).toBe(1);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('"reason_code":"audit.history_limit"'),
  );
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('"event":"audit.sink_admin_refused"'),
  );
  expect(console.error).toHaveBeenLastCalledWith('audit sink: history_limit');
});

it('prints policy_unavailable when required has no applicable durable path', async () => {
  await database.executor.batch([
    {
      sql: "UPDATE audit_chain SET mode = 'none' WHERE org_id = ?",
      params: [orgId],
    },
  ]);
  expect(await run(['audit', 'policy', 'set', 'required', ...args()])).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit sink: policy_unavailable');
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
      params: [orgId],
    }),
  ).toEqual([]);
});
