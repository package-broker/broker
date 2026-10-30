import { afterAll, beforeAll, expect, expectTypeOf, it } from 'vitest';
import type { Insertable, Selectable } from 'kysely';
import type { AuditChainTable, AuditLedgerTable, AuditSinkTable, Database } from './schema.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

type AuditTable = 'audit_chain' | 'audit_sink' | 'audit_ledger';
type Nullability<T extends AuditTable> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};
const declared: { [T in AuditTable]: Nullability<T> } = {
  audit_chain: {
    org_id: 1,
    chain_id: 1,
    epoch: 1,
    incarnation: 1,
    head_seq: 1,
    head_hash: 1,
    boundary_seq: 1,
    boundary_prev_hash: 1,
    boundary_reason: 0,
    mode: 1,
    mode_generation: 1,
    policy: 1,
    pending_mode: 0,
    cutover_seq: 0,
    capacity_state: 1,
    capacity_evict_to: 0,
    journal_rows: 1,
    journal_bytes: 1,
    restore_pending: 1,
    integrity_incidents: 1,
    verified_from_seq: 0,
    verified_through_seq: 0,
    verified_bodies: 0,
    verified_withheld: 0,
    verified_at: 0,
  },
  audit_sink: {
    org_id: 1,
    sink_id: 1,
    plugin_id: 1,
    kind: 1,
    generation: 1,
    receiver_fingerprint: 1,
    durable_ack: 1,
    activation_source: 1,
    state: 1,
    progress_seq: 1,
    progress_hash: 1,
    custody_seq: 1,
    inflight_from: 0,
    inflight_to: 0,
    inflight_body: 0,
    inflight_repr: 0,
    next_attempt_at: 0,
    attempt: 1,
    retry_count_for_seq: 1,
    body_version: 1,
    blocked_reason: 0,
    last_error_code: 0,
    created_at: 1,
    updated_at: 1,
  },
  audit_ledger: {
    org_id: 1,
    id: 1,
    kind: 1,
    chain_id: 1,
    epoch: 1,
    from_seq: 1,
    to_seq: 1,
    count: 1,
    sink_id: 0,
    reason_code: 1,
    policy: 1,
    mode_generation: 1,
    actor_type: 1,
    actor_id: 0,
    created_at: 1,
    superseded_by: 0,
    resolves_id: 0,
    capacity_json: 0,
  },
};
let database: MigratedDatabase;
beforeAll(async () => {
  database = await openMigratedDatabase();
});
afterAll(async () => {
  await database.close();
});

for (const [table, columns] of Object.entries(declared)) {
  it(`${table} types match migrated columns and nullability`, async () => {
    const actual = await database.executor.all<{ name: string; notnull: number }>({
      sql: `SELECT name, "notnull" FROM pragma_table_info('${table}')`,
      params: [],
    });
    expect(Object.fromEntries(actual.map((column) => [column.name, column.notnull]))).toEqual(
      columns,
    );
  });
}

it('audit enums and generated defaults have their published database types', () => {
  expectTypeOf<Selectable<AuditChainTable>['mode']>().toEqualTypeOf<'trail' | 'export' | 'none'>();
  expectTypeOf<Selectable<AuditChainTable>['policy']>().toEqualTypeOf<
    'availability' | 'required'
  >();
  expectTypeOf<Selectable<AuditChainTable>['capacity_state']>().toEqualTypeOf<
    'ok' | 'warning' | 'refusing'
  >();
  expectTypeOf<AuditSinkTable['state']>().toEqualTypeOf<
    'active' | 'inactive' | 'blocked' | 'disabled' | 'retired'
  >();
  expectTypeOf<AuditSinkTable['durable_ack']>().toEqualTypeOf<0 | 1>();
  expectTypeOf<AuditLedgerTable['kind']>().toEqualTypeOf<
    | 'skipped'
    | 'uncertain'
    | 'gap'
    | 'withheld'
    | 'mode_change'
    | 'policy_change'
    | 'cutover'
    | 'rebind'
    | 'retire'
    | 'unblock'
    | 'restore_confirmed'
    | 'export'
    | 'replay'
    | 'chain_reset'
    | 'epoch_bump'
  >();
  expectTypeOf<Insertable<AuditChainTable>['chain_id']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<Insertable<AuditSinkTable>['attempt']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Insertable<AuditLedgerTable>['created_at']>().toEqualTypeOf<string | undefined>();
});

it('indexes visible ledger rows with partial indexes that exclude superseded gaps', async () => {
  const indexes = await database.executor.all<{ name: string; sql: string }>({
    sql: "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name IN ('audit_ledger_open_gap', 'audit_ledger_visible', 'audit_ledger_superseded') ORDER BY name",
    params: [],
  });
  expect(indexes.map(({ name, sql }) => [name, sql.slice(sql.indexOf(' ON '))])).toEqual([
    [
      'audit_ledger_open_gap',
      " ON audit_ledger (org_id, chain_id, epoch, reason_code, sink_id, from_seq, id) WHERE kind = 'gap' AND superseded_by IS NULL",
    ],
    [
      'audit_ledger_superseded',
      ' ON audit_ledger (org_id, superseded_by) WHERE superseded_by IS NOT NULL',
    ],
    ['audit_ledger_visible', ' ON audit_ledger (org_id, id) WHERE superseded_by IS NULL'],
  ]);
});
