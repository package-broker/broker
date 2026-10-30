import type { Statement } from '@package-broker/core/db/port';
import { auditEpochCarryStatements } from './audit-epoch-carry.js';
import { afterEach, expect, it } from 'vitest';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { isolation } from '../testing/mutation-table/audit-status.js';
import { createAuditStatusReader } from './audit-status.js';

let database: MigratedDatabase;
afterEach(async () => {
  await database?.close();
});
it('isolates every status selection by organization', async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  await isolation.run({
    executor: database.executor,
    orgs: database.orgs!,
    mutate: (s) => s,
    mutateBatch: (s) => s,
  });
  expect(await createAuditStatusReader(database.executor).read(database.orgs!.a)).toMatchObject({
    mode: 'none',
    pendingCount: 1,
    sinks: [
      {
        id: 'sink',
        state: 'blocked',
        progressSeq: 0,
        custodySeq: 0,
        durableAck: true,
        activationSource: 'build',
      },
    ],
    ledger: [{ kind: 'gap', count: 1 }],
  });
});
it('preserves empty verification scope and rejects a missing chain', async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const { a } = database.orgs!;
  await database.executor.batch([
    {
      sql: `UPDATE audit_chain SET verified_from_seq = 1, verified_through_seq = 0,
      verified_bodies = 0, verified_withheld = 0, verified_at = 'now' WHERE org_id = ?`,
      params: [a.orgId],
    },
  ]);
  const reader = createAuditStatusReader(database.executor);
  expect((await reader.read(a)).verification).toEqual({
    fromSeq: 1,
    throughSeq: 0,
    bodies: 0,
    withheld: 0,
    verifiedAt: 'now',
  });
  await expect(reader.read({ orgId: 'absent' } as typeof a)).rejects.toThrow(
    'Audit status unavailable',
  );
});

it('refuses an incomplete stored verification scope without returning row data', async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const { a } = database.orgs!;
  await database.executor.batch([
    {
      sql: "UPDATE audit_chain SET verified_at = 'now' WHERE org_id = ?",
      params: [a.orgId],
    },
  ]);
  await expect(createAuditStatusReader(database.executor).read(a)).rejects.toThrow(
    'Audit status unavailable',
  );
});

it('counts only current timeline incidents with indexed seeks, including carried rows once', async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const org = database.orgs!.a;
  await isolation.run({
    executor: database.executor,
    orgs: database.orgs!,
    mutate: (s) => s,
    mutateBatch: (s) => s,
  });
  const insert = (
    id: string,
    kind: string,
    count: number,
    resolvesId: string | null = null,
  ): Statement => ({
    sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
      sink_id, reason_code, policy, mode_generation, actor_type, created_at, resolves_id)
      SELECT org_id, ?, ?, chain_id, epoch, 1, 1, ?, 'sink', 'test_reason', policy, mode_generation,
        'system', 'now', ? FROM audit_chain WHERE org_id = ?`,
    params: [id, kind, count, resolvesId, org.orgId],
  });
  await database.executor.batch([
    insert('withheld', 'withheld', 2),
    insert('skipped', 'skipped', 3),
    insert('open', 'uncertain', 4),
    insert('resolved', 'uncertain', 5),
    insert('resolution', 'replay', 5, 'resolved'),
    insert('export', 'export', 6),
    insert('reset', 'chain_reset', 7),
    {
      sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
        reason_code, policy, mode_generation, actor_type, created_at)
        SELECT org_id, 'other-chain', 'gap', 'ffffffffffffffffffffffffffffffff', epoch, 1, 1, 99,
          'seq_gap', policy, mode_generation, 'system', 'now' FROM audit_chain WHERE org_id = ?`,
      params: [org.orgId],
    },
  ]);
  let summary: Statement | undefined;
  const reader = createAuditStatusReader({
    ...database.executor,
    batch: (statements) => {
      summary = statements[3];
      return database.executor.batch(statements);
    },
  });
  expect((await reader.read(org)).ledger).toEqual([
    { kind: 'gap', count: 1 },
    { kind: 'skipped', count: 3 },
    { kind: 'uncertain', count: 4 },
    { kind: 'withheld', count: 2 },
  ]);
  const plan = await database.executor.all<{ detail: string }>({
    sql: `EXPLAIN QUERY PLAN ${summary!.sql}`,
    params: summary!.params,
  });
  expect(plan.map(({ detail }) => detail)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^SEARCH audit_ledger USING INDEX audit_ledger_kind_chain \(org_id=\? AND kind=\? AND chain_id=\? AND epoch=\?\)/,
      ),
      expect.stringMatching(/^SEARCH resolution USING COVERING INDEX audit_ledger_resolves/),
    ]),
  );
  expect(plan.some(({ detail }) => /^SCAN (audit_ledger|resolution)/.test(detail))).toBe(false);
  const before = await reader.read(org);
  await database.executor.batch([
    ...(await auditEpochCarryStatements(database.executor, org.orgId, before.epoch + 1, 'later')),
    { sql: 'UPDATE audit_chain SET epoch = epoch + 1 WHERE org_id = ?', params: [org.orgId] },
  ]);
  expect((await reader.read(org)).ledger).toEqual([
    { kind: 'gap', count: 1 },
    { kind: 'uncertain', count: 4 },
    { kind: 'withheld', count: 2 },
  ]);
  const rows = await database.executor.all<{ count: number }>({
    sql: "SELECT count(*) AS count FROM audit_ledger WHERE org_id = ? AND kind = 'gap' AND chain_id = ?",
    params: [org.orgId, before.chainId],
  });
  expect(rows[0]!.count).toBe(2);
});
