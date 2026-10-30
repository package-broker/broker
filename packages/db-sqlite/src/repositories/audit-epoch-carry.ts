import { ulid } from '@package-broker/core/ids';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

export const AUDIT_EPOCH_CARRY_LIMIT = 2048;

export class AuditEpochCarryLimitError extends Error {
  override readonly name = 'AuditEpochCarryLimitError';
  constructor() {
    super('Audit epoch carry exceeds its limit');
  }
}

/** Ledger rows of the current chain and epoch that still govern a retained or allocatable seq. */
const CARRIED = `FROM audit_chain carry_chain JOIN audit_ledger carried
    ON carried.org_id = carry_chain.org_id AND carried.chain_id = carry_chain.chain_id
      AND carried.epoch = carry_chain.epoch
  WHERE carry_chain.org_id = ? AND carried.superseded_by IS NULL
    AND carried.to_seq >= carry_chain.boundary_seq - 1
    AND ((carried.kind = 'gap' AND carried.sink_id IS NULL
        AND carried.reason_code IN ('seq_gap', 'capacity'))
      OR carried.kind = 'withheld'
      OR (carried.kind = 'uncertain' AND NOT EXISTS (SELECT 1 FROM audit_ledger resolution
        WHERE resolution.org_id = carried.org_id AND resolution.kind = 'replay'
          AND resolution.resolves_id = carried.id)))`;

/**
 * Copies the carried rows into `nextEpoch` under fresh ids. The statements must run in the
 * epoch transition batch before the chain row changes epoch; the guard refuses the batch when
 * the carried set changed after it was read.
 */
export async function auditEpochCarryStatements(
  executor: Pick<ScalarSqlExecutor, 'all'>,
  orgId: string,
  nextEpoch: number,
  now: string,
): Promise<ScalarStatement[]> {
  const rows = await executor.all<{ id: string }>({
    sql: `SELECT carried.id ${CARRIED} ORDER BY carried.id LIMIT ?`,
    params: [orgId, AUDIT_EPOCH_CARRY_LIMIT + 1],
  });
  if (rows.length > AUDIT_EPOCH_CARRY_LIMIT) throw new AuditEpochCarryLimitError();
  const mapping = JSON.stringify(rows.map(({ id }) => [id, ulid()]));
  return [
    {
      sql: `INSERT INTO access_mutation_guard (key) SELECT ? FROM (SELECT 1 UNION ALL SELECT 2)
        WHERE (SELECT count(*) ${CARRIED}) <> ? OR EXISTS (SELECT 1 ${CARRIED}
          AND carried.id NOT IN (SELECT json_extract(value, '$[0]') FROM json_each(?)))`,
      params: [ulid(), orgId, rows.length, orgId, mapping],
    },
    ...(rows.length === 0
      ? []
      : [
          {
            sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
              sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at, capacity_json)
            SELECT source.org_id, json_extract(m.value, '$[1]'), source.kind, source.chain_id, ?,
              source.from_seq, source.to_seq, source.count, source.sink_id, source.reason_code,
              source.policy, source.mode_generation, source.actor_type, source.actor_id, ?,
              source.capacity_json
            FROM json_each(?) m JOIN audit_ledger source
              ON source.org_id = ? AND source.id = json_extract(m.value, '$[0]')`,
            params: [nextEpoch, now, mapping, orgId],
          },
        ]),
  ];
}
