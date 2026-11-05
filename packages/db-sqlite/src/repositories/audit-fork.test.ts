import { expect, it } from 'vitest';
import type { Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { auditForkRepositorySuite, seedAuditFork } from '../testing/audit-fork-suite.js';
import { createAuditForkRepository } from './audit-fork.js';
import { auditEpochCarryStatements } from './audit-epoch-carry.js';

await auditForkRepositorySuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);

async function plan(database: MigratedDatabase, statement: Statement) {
  return (
    await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    })
  ).map((row) => row.detail);
}

it('reads fork history with per-chain seeks however many resets other chains hold', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    const org = database.orgs!.a;
    await seedAuditFork(database.executor, org);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ? WHERE org_id = ?',
        params: ['c'.repeat(32), org.orgId],
      },
    ]);
    await database.executor.batch([
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
        INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT printf('reset-%06d', i), org_id, 'chain_reset',
          CASE WHEN i % 10 = 0 THEN 'e' ELSE 'd' END || substr(chain_id, 2), i % 5, 1, 1, 0, NULL,
          'tamper_detected', policy, mode_generation, 'system', '2026-10-01T00:00:00.000Z'
        FROM audit_chain, n WHERE org_id = ?`,
        params: [org.orgId],
      },
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
        INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT printf('other-%05d', i), org_id, CASE i % 2 WHEN 0 THEN 'skipped' ELSE 'replay' END,
          chain_id, i % 7, i, i, 1, 'archive', 'test_reason', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z'
        FROM audit_chain, n WHERE org_id = ?`,
        params: [org.orgId],
      },
    ]);
    let history: Statement | undefined;
    const port = createAuditForkRepository({
      ...database.executor,
      all: (statement) => database.executor.all(statement),
      batch: (statements) => {
        history = statements[2];
        return database.executor.batch(statements);
      },
    });
    const resets = (await port.read(org)).history!.filter((row) => row.kind === 'chain_reset');
    expect(resets.map((row) => row.id).sort()).toEqual(['reset-029999', 'reset-030000']);
    const steps = await plan(database, history!);
    const ledger = steps.filter((detail) =>
      / (gap|first_reset|following|reset|pick|latest) /.test(detail),
    );
    expect(ledger).toHaveLength(6);
    for (const detail of ledger) expect(detail).toMatch(/^SEARCH /);
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^SEARCH gap USING INDEX audit_ledger_open_gap \(org_id=\? AND chain_id=\? AND epoch=\?/,
        ),
        expect.stringMatching(/^SEARCH first_reset USING .*INDEX \w+ \(org_id=\? AND kind=\?\)$/),
        expect.stringMatching(
          /^SEARCH following USING .*INDEX \w+ \(org_id=\? AND kind=\? AND chain_id>\?\)$/,
        ),
        expect.stringMatching(
          /^SEARCH reset USING INDEX sqlite_autoindex_audit_ledger_1 \(org_id=\? AND id=\?\)$/,
        ),
        expect.stringMatching(
          /^SEARCH pick USING INDEX audit_ledger_reset \(org_id=\? AND chain_id=\?\)$/,
        ),
        expect.stringMatching(
          /^SEARCH latest USING INDEX audit_ledger_kind_chain \(org_id=\? AND kind=\? AND chain_id=\? AND epoch=\?\)$/,
        ),
      ]),
    );
    expect(steps.filter((detail) => detail.startsWith('USE TEMP B-TREE'))).toEqual([
      'USE TEMP B-TREE FOR ORDER BY',
    ]);
  } finally {
    await database.close();
  }
});

it('checks carry resolutions through the resolves index in selection and guard', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    const org = database.orgs!.a;
    await seedAuditFork(database.executor, org);
    let selection: Statement | undefined;
    const statements = await auditEpochCarryStatements(
      {
        all: (statement) => {
          selection = statement;
          return database.executor.all(statement);
        },
      },
      org.orgId,
      1,
      '2026-10-30T00:00:00.000Z',
    );
    for (const statement of [selection!, statements[0]!]) {
      const steps = await plan(database, statement);
      const resolution = steps.filter((detail) => / resolution /.test(detail));
      expect(resolution.length).toBeGreaterThanOrEqual(1);
      for (const detail of resolution)
        expect(detail).toMatch(
          /^SEARCH resolution USING INDEX audit_ledger_resolves \(org_id=\? AND resolves_id=\?\)$/,
        );
      for (const detail of steps.filter((value) => / carried /.test(value)))
        expect(detail).toMatch(/^SEARCH carried USING /);
    }
  } finally {
    await database.close();
  }
});

it('resolves by primary key and seeks the resolution index with organization isolation', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    let lookup: Statement | undefined;
    const port = createAuditForkRepository({
      driver: database.executor.driver,
      all: (statement) => {
        lookup = statement;
        return database.executor.all(statement);
      },
      batch: (statements) => database.executor.batch(statements),
    });
    expect(await port.resolution(database.orgs!.a, '01JZZZZZZZZZZZZZZZZZZZZZZX')).toEqual({
      target: null,
      resolved: false,
    });
    const details = await plan(database, lookup!);
    expect(
      details.some((line) =>
        /SEARCH l USING INDEX sqlite_autoindex_audit_ledger_1.*org_id=.*id=/.test(line),
      ),
    ).toBe(true);
    expect(
      details.some((line) =>
        /SEARCH r USING INDEX audit_ledger_resolves.*org_id=.*resolves_id=/.test(line),
      ),
    ).toBe(true);
    expect(details.some((line) => /SCAN (l|r)\b/.test(line))).toBe(false);
  } finally {
    await database.close();
  }
});
