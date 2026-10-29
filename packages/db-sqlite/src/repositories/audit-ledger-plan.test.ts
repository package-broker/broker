import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import type { ScalarStatement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditLedgerRepository } from './audit-ledger.js';

const HISTORY = 10_000;
const OPEN_GAP_RANGE =
  /^SEARCH \w+ USING INDEX audit_ledger_open_gap \(org_id=\? AND chain_id=\? AND epoch=\? AND reason_code=\? AND sink_id=\? AND from_seq[<>]\?/;
const BY_ID =
  /^SEARCH \w+ USING (?:COVERING )?INDEX sqlite_autoindex_audit_ledger_1 \(org_id=\? AND id=\?\)$/;
const BY_COVERER =
  /^SEARCH \w+ USING (?:COVERING )?INDEX audit_ledger_superseded \(org_id=\? AND superseded_by=\?\)$/;
const VISIBLE = /^SEARCH current USING INDEX audit_ledger_visible \(org_id=\?(?: AND id>\?)?\)$/;
/** Each alias reaching audit_ledger and the constraints its access must bind. */
const REQUIRED: Readonly<Record<string, RegExp>> = {
  open_gap: OPEN_GAP_RANGE,
  visible_gap: OPEN_GAP_RANGE,
  candidate_gap: OPEN_GAP_RANGE,
  stored: BY_ID,
  covering_gap: BY_ID,
  audit_ledger: BY_ID,
  hidden: BY_COVERER,
  absorbed_gap: BY_COVERER,
  current: VISIBLE,
};
const LEDGER_ACCESS = new RegExp(`^(?:SCAN|SEARCH) (${Object.keys(REQUIRED).join('|')})\\b`);

const entry: AuditLedgerEntry = {
  id: '01K7R5V0000000000000000000',
  kind: 'gap',
  chainId: 'a'.repeat(32),
  epoch: 0,
  fromSeq: 1,
  toSeq: 1,
  count: 1,
  sinkId: null,
  reasonCode: 'capacity',
  policy: 'availability',
  modeGeneration: 0,
  actorType: 'system',
  actorId: null,
  createdAt: '2026-10-28T10:00:00.000Z',
};
const idAt = (n: number) => `01K7R5V${String(n).padStart(19, '0')}`;

let database: MigratedDatabase;
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
});
afterEach(async () => {
  await database.close();
});

it('reaches ledger rows only through visible-row indexes after 10,000 superseding rows', async () => {
  const { a } = database.orgs!;
  await database.executor.batch([
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
          sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at)
        SELECT ?, '01K7R5V' || printf('%019d', i), 'gap', ?, 0, 1, i, i, NULL, 'capacity',
          'availability', 0, 'system', NULL, ?
        FROM n`,
      params: [HISTORY, a.orgId, entry.chainId, entry.createdAt],
    },
    {
      sql: `UPDATE audit_ledger SET superseded_by = '01K7R5V' || printf('%019d', to_seq + 1)
        WHERE org_id = ? AND to_seq < ?`,
      params: [a.orgId, HISTORY],
    },
  ]);
  const executed: ScalarStatement[] = [];
  const repository = createAuditLedgerRepository({
    driver: database.executor.driver,
    all(statement) {
      executed.push(statement);
      return database.executor.all(statement);
    },
    batch(statements) {
      executed.push(...statements);
      return database.executor.batch(statements);
    },
  });
  const next = { ...entry, id: idAt(HISTORY + 1), fromSeq: HISTORY + 1, toSeq: HISTORY + 1 };
  const plans: string[][] = [];
  const explain = async (statements: readonly ScalarStatement[]) => {
    for (const statement of statements) {
      const rows = await database.executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        params: statement.params,
      });
      plans.push(rows.map(({ detail }) => detail));
    }
  };
  await explain(repository.statements(a, [next]));
  await repository.append(a, [next]);
  await repository.append(a, [next]);
  executed.length = 0;
  expect(await repository.effectiveGaps(a)).toEqual([{ ...next, fromSeq: 1, count: HISTORY + 1 }]);
  expect(await repository.page(a, null, 500)).toEqual([
    { ...next, fromSeq: 1, count: HISTORY + 1 },
  ]);
  await explain(executed);
  expect(plans).toHaveLength(4);
  const accesses = plans.flat().flatMap((line) => {
    const alias = LEDGER_ACCESS.exec(line)?.[1];
    return alias === undefined ? [] : [{ alias, line }];
  });
  expect(new Set(accesses.map(({ alias }) => alias))).toEqual(new Set(Object.keys(REQUIRED)));
  expect(accesses.filter(({ alias, line }) => !REQUIRED[alias]!.test(line))).toEqual([]);
});
