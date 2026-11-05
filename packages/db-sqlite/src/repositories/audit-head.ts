import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { auditWireMarker } from '@package-broker/core/audit/wire';

/** Queue the daily checkpoint through the exporter's persisted, non-advancing marker path. */
export async function queueAuditHead(
  executor: SqlExecutor,
  org: OrgContext,
  generation: number,
  now: Date,
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const [chain] = await executor.all<{
    chain_id: string;
    epoch: number;
    incarnation: number;
    head_seq: number;
    head_hash: string;
    boundary_seq: number;
  }>({
    sql: 'SELECT chain_id, epoch, incarnation, head_seq, head_hash, boundary_seq FROM audit_chain WHERE org_id = ? AND restore_pending = 0',
    params: [org.orgId],
  });
  if (chain === undefined) return;
  const marker = await auditWireMarker(
    { chainId: chain.chain_id, epoch: chain.epoch },
    {
      kind: 'head',
      seq: chain.head_seq,
      hash: chain.head_hash,
      boundarySeq: chain.boundary_seq,
    },
  );
  // json_insert appends without replacing a frozen event or registry-marker body.
  await executor.batch([
    {
      sql: `UPDATE audit_sink SET inflight_repr = json_insert(
        json_set(inflight_repr, '$.headDay', ?, '$.registryMarkers',
          json(coalesce(json_extract(inflight_repr, '$.registryMarkers'), '[]'))),
        '$.registryMarkers[#]', json(?)), body_version = body_version + 1
      WHERE org_id = ? AND state = 'active' AND generation <= ?
        AND coalesce(json_extract(inflight_repr, '$.headDay'), '') < ?
        AND EXISTS (SELECT 1 FROM audit_chain c WHERE c.org_id = ? AND c.chain_id = ?
          AND c.epoch = ? AND c.incarnation = ?
          AND c.restore_pending = 0)
        AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ? AND s.generation > ?)`,
      params: [
        day,
        JSON.stringify({ ...marker, queueId: ulid(now.getTime()) }),
        org.orgId,
        generation,
        day,
        org.orgId,
        chain.chain_id,
        chain.epoch,
        chain.incarnation,
        org.orgId,
        generation,
      ],
    },
  ]);
}
