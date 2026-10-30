import { expect, it } from 'vitest';
import type { Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditForkRepositorySuite, seedAuditFork } from '../testing/audit-fork-suite.js';
import { createAuditForkRepository } from './audit-fork.js';

await auditForkRepositorySuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);

it('reads fork history through indexes with a large irrelevant ledger', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    const org = database.orgs!.a;
    await seedAuditFork(database.executor, org);
    await database.executor.batch([
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
        INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT printf('skip-%05d', i), org_id, CASE i % 3 WHEN 0 THEN 'skipped' WHEN 1 THEN 'replay' ELSE 'chain_reset' END,
          chain_id, i % 7, i, i, 1, CASE i % 3 WHEN 2 THEN NULL ELSE 'archive' END, 'test_reason', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z'
        FROM audit_chain, n WHERE org_id = ?`,
        params: [org.orgId],
      },
    ]);
    let history: Statement | undefined;
    await createAuditForkRepository({
      ...database.executor,
      all: (statement) => database.executor.all(statement),
      batch: (statements) => {
        history = statements[2];
        return database.executor.batch(statements);
      },
    }).read(org);
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${history!.sql}`,
      params: history!.params,
    });
    const ledgerSteps = plan
      .map((row) => row.detail)
      .filter((detail) => / (gap|reset|newer|latest)\b/.test(detail));
    expect(ledgerSteps.length).toBeGreaterThanOrEqual(4);
    for (const detail of ledgerSteps)
      expect(detail).toMatch(
        detail.startsWith('SEARCH gap ')
          ? /USING INDEX audit_ledger_open_gap \(org_id=\? AND chain_id=\? AND epoch=\?/
          : /^SEARCH (reset|newer|latest) USING INDEX audit_ledger_kind_chain \(org_id=\? AND kind=\?/,
      );
  } finally {
    await database.close();
  }
});
