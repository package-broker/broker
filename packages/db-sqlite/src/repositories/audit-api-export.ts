import type { AuditExportStore } from '@package-broker/core/api/routes/audit-export';
import { assertAuditLedgerEntry, type AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { REAUTH_WINDOW_MS } from '@package-broker/core/auth/session';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { sql, type SqlBool } from 'kysely';
import { assertCheck, compile, db, type ProtectedHolderProvider } from '../kysely.js';
import { permissionRows } from './access.js';
import { actorAuthority } from './actor-authority.js';
import { createAuditJournalReader } from './audit-query.js';
import { createAuditLedgerRepository } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';

export function createAuditApiExportStore(
  executor: ScalarSqlExecutor,
  providers: readonly ProtectedHolderProvider[] = [],
): AuditExportStore {
  const ledger = createAuditLedgerRepository(executor);
  const rate = (
    orgId: string,
    userId: string,
  ) => sql<SqlBool>`(select count(*) from audit_ledger where org_id = ${orgId}
    and superseded_by IS NULL and kind = 'export' and reason_code = 'api_export' and actor_type = 'user'
    and actor_id = ${userId} and created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')) < 10`;
  return {
    async rateAvailable(org, userId) {
      const [row] = await executor.all<{ holds: number }>(
        compile(
          db.selectNoFrom(
            sql<number>`case when ${rate(org.orgId, userId)} then 1 else 0 end`.as('holds'),
          ),
        ) as ScalarStatement,
      );
      return row?.holds === 1;
    },
    journal: (org) => createAuditJournalReader(executor, org, undefined, 2000),
    async snapshot(org) {
      const head = await createAuditJournalReader(executor, org).head();
      const [row] = await executor.all<{
        policy: 'availability' | 'required';
        modeGeneration: number;
      }>({
        sql: 'SELECT policy, mode_generation AS modeGeneration FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      });
      if (row === undefined) throw new Error('Audit journal unavailable');
      return { head, ...row };
    },
    async dispositions(org, snapshot, from, to) {
      const rows = await executor.all<AuditLedgerEntry & { capacityJson: string | null }>({
        sql: `SELECT id, kind, chain_id AS chainId, epoch, from_seq AS fromSeq, to_seq AS toSeq,
          count, sink_id AS sinkId, reason_code AS reasonCode, policy, mode_generation AS modeGeneration,
          actor_type AS actorType, actor_id AS actorId, created_at AS createdAt,
          resolves_id AS resolvesId, capacity_json AS capacityJson FROM audit_ledger
          WHERE org_id = ? AND chain_id = ? AND epoch = ? AND superseded_by IS NULL
            AND from_seq <= ? AND to_seq >= ? AND kind IN ('gap', 'skipped', 'uncertain', 'withheld', 'replay')
          ORDER BY from_seq, id LIMIT 2001`,
        params: [org.orgId, snapshot.head.chainId, snapshot.head.epoch, to, from],
      });
      return rows.map(({ capacityJson, ...row }) => {
        const entry: AuditLedgerEntry = {
          ...row,
          ...(capacityJson === null
            ? {}
            : { capacity: JSON.parse(capacityJson) as NonNullable<AuditLedgerEntry['capacity']> }),
        };
        assertAuditLedgerEntry(entry);
        return entry;
      });
    },
    async record(org, fence, snapshot, event, entries) {
      if (entries.length !== 1 || entries[0]?.kind !== 'export') return 'unavailable';
      const { head } = snapshot;
      const [time] = await executor.all<{ now: string }>({
        sql: "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now",
        params: [],
      });
      if (time === undefined) return 'unavailable';
      const authority = actorAuthority(org, fence, {
        permission: 'org:audit:export',
        projectId: null,
        providerAnchors: providers,
        sessionCondition: (alias) =>
          sql<SqlBool>`${sql.ref(`${alias}.reauth_at`)} between strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${REAUTH_WINDOW_MS / 1000} seconds`}) and strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      });
      const localAdmin = sql<SqlBool>`exists (select 1 from session where org_id = ${org.orgId} and id = ${fence.sessionId} and identity_id is null)`;
      const admin = sql<SqlBool>`exists ${db
        .selectFrom(
          permissionRows(org, fence.userId, null, providers, { localAdmin }).as(
            'admin_rows',
          ) as never,
        )
        .select(sql.lit(1).as('one'))
        .where(sql<SqlBool>`admin_rows.scope = 'organization' and admin_rows.protects = 1`)}`;
      const allowed = sql<SqlBool>`(${authority} and ${admin})`;
      const stable = sql<SqlBool>`exists (select 1 from audit_chain where org_id = ${org.orgId}
        and chain_id = ${head.chainId} and epoch = ${head.epoch} and boundary_seq <= ${entries[0]!.fromSeq} and policy = ${snapshot.policy}
        and mode_generation = ${snapshot.modeGeneration})`;
      const probe = (guard: typeof allowed) =>
        compile(
          db.selectNoFrom(sql<number>`case when ${guard} then 1 else 0 end`.as('holds')),
        ) as ScalarStatement;
      const pending = auditPendingStatement(org, event) as ScalarStatement;
      const batch = [
        ...assertCheck(allowed),
        ...assertCheck(stable),
        ...assertCheck(rate(org.orgId, fence.userId)),
        ...ledger.statements(
          org,
          entries.map((entry) => ({ ...entry, createdAt: time.now })),
        ),
        { ...pending, sql: `${pending.sql} RETURNING id` },
      ] as readonly ScalarStatement[];
      if (batch.length > 200) return 'payload_too_large';
      if (batch.some((statement) => statement.params.length > 100)) return 'unavailable';
      try {
        const result = await executor.batch(batch);
        return result.at(-1)?.rows?.length === 1 ? 'recorded' : 'unavailable';
      } catch {
        const [live] = await executor.all<{ holds: number }>(probe(allowed));
        if (live?.holds !== 1) return 'forbidden';
        const [current] = await executor.all<{ holds: number }>(probe(stable));
        if (current?.holds !== 1) return 'conflict';
        const [available] = await executor.all<{ holds: number }>(
          probe(rate(org.orgId, fence.userId)),
        );
        return available?.holds === 0 ? 'rate_limited' : 'unavailable';
      }
    },
  };
}
