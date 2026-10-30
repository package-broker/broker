import {
  AUDIT_ALERT_CODES,
  type AuditAlertCode,
  type AuditHealthPort,
  type AuditHealthSnapshot,
  type AuditHealthObservation,
  type AuditHealthStoredAlert,
} from '@package-broker/core/audit/health';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

const LEDGER_ALERT_CODES: Readonly<Record<string, AuditAlertCode | undefined>> = {
  chain_reset: 'audit.chain_integrity',
  epoch_bump: 'audit.fork',
  skipped: 'audit.skipped',
  uncertain: 'audit.uncertain',
  gap: 'audit.gap',
  withheld: 'audit.withheld',
  mode_change: 'audit.mode_change',
  policy_change: 'audit.policy_change',
};

const healthSelect = `SELECT code, origin, fingerprint, revision,
  acknowledged_revision AS acknowledgedRevision, active, failing
  FROM audit_health WHERE org_id = ? ORDER BY code, origin`;
function stored(row: Record<string, unknown>): AuditHealthStoredAlert {
  return {
    code: row['code'] as AuditAlertCode,
    origin: row['origin'] as AuditHealthStoredAlert['origin'],
    fingerprint: String(row['fingerprint']),
    revision: Number(row['revision']),
    acknowledgedRevision: Number(row['acknowledgedRevision']),
    active: Boolean(row['active']),
    failing: Boolean(row['failing']),
  };
}
const nextRevision = `(SELECT coalesce(max(revision), 0) + 1 FROM audit_health
  WHERE org_id = ? AND code = ?)`;

export function createAuditHealthRepository(executor: ScalarSqlExecutor): AuditHealthPort {
  return {
    async raise(ctx, code) {
      if (!AUDIT_ALERT_CODES.includes(code)) throw new TypeError('Invalid audit alert code');
      await executor.all({
        sql: `INSERT INTO audit_health (org_id, code, origin, fingerprint, revision, acknowledged_revision, active, failing)
          VALUES (?, ?, 'source', '', ${nextRevision}, 0, 0, 0)
          ON CONFLICT (org_id, code, origin) DO UPDATE SET revision = excluded.revision RETURNING code`,
        params: [ctx.orgId, code, ctx.orgId, code],
      });
    },
    async snapshot(ctx) {
      const results = await executor.batch([
        {
          sql: `SELECT mode, pending_mode AS pendingMode, capacity_state AS capacityState,
          restore_pending AS restorePending FROM audit_chain WHERE org_id = ?`,
          params: [ctx.orgId],
        },
        {
          sql: 'SELECT created_at AS oldest FROM audit_pending WHERE org_id = ? ORDER BY id LIMIT 1',
          params: [ctx.orgId],
        },
        {
          sql: 'SELECT sink_id AS id, state, blocked_reason AS blockedReason FROM audit_sink WHERE org_id = ?',
          params: [ctx.orgId],
        },
        {
          sql: `SELECT kind, reason_code AS reason, sum(coalesce(count, 1)) AS total FROM audit_ledger
            WHERE org_id = ? AND superseded_by IS NULL GROUP BY kind, reason_code`,
          params: [ctx.orgId],
        },
        { sql: healthSelect, params: [ctx.orgId] },
      ]);
      const chain = results[0]!.rows[0];
      if (chain === undefined) throw new Error('Audit chain unavailable');
      const grouped = new Map<AuditAlertCode, { reasons: Set<string>; total: number }>();
      for (const row of results[3]!.rows) {
        const kind = String(row['kind']);
        const reason = String(row['reason']);
        const code: AuditAlertCode | undefined =
          reason === 'marker_rejected'
            ? 'audit.marker_rejected'
            : kind === 'gap' && reason === 'capacity'
              ? 'audit.capacity'
              : LEDGER_ALERT_CODES[kind];
        if (code !== undefined) {
          const group = grouped.get(code) ?? { reasons: new Set<string>(), total: 0 };
          group.reasons.add(`${kind}:${reason}`);
          group.total += Number(row['total']);
          grouped.set(code, group);
        }
      }
      const incidents: AuditHealthObservation[] = [...grouped].map(([code, group]) => ({
        code,
        origin: 'ledger',
        fingerprint: `${[...group.reasons].sort().join('|')}:${Math.floor(Math.log2(Math.max(1, group.total)))}`,
        failing: false,
        active: false,
      }));
      return {
        mode: (chain['pendingMode'] ?? chain['mode']) as AuditHealthSnapshot['mode'],
        capacityState: chain['capacityState'] as AuditHealthSnapshot['capacityState'],
        restorePending: Boolean(chain['restorePending']),
        oldestPendingAt: (results[1]!.rows[0]?.['oldest'] as string | undefined) ?? null,
        sinks: results[2]!.rows as unknown as AuditHealthSnapshot['sinks'],
        incidents,
        alerts: results[4]!.rows.map(stored),
      };
    },
    async observe(ctx, observations, current) {
      if (
        observations.length > AUDIT_ALERT_CODES.length * 2 ||
        new Set(observations.map((o) => `${o.code}:${o.origin ?? 'live'}`)).size !==
          observations.length ||
        observations.some(
          (o) =>
            !AUDIT_ALERT_CODES.includes(o.code) ||
            (o.origin !== undefined && o.origin !== 'ledger' && o.origin !== 'live') ||
            typeof o.fingerprint !== 'string' ||
            o.fingerprint.length > 4096,
        )
      )
        throw new TypeError('Invalid audit health observation');
      const prior =
        current ??
        (await executor.batch([{ sql: healthSelect, params: [ctx.orgId] }]))[0]!.rows.map(stored);
      const changed = observations.filter((item) => {
        const row = prior.find((r) => r.code === item.code && r.origin === (item.origin ?? 'live'));
        return (
          row === undefined ||
          row.active !== (item.active !== false) ||
          row.fingerprint !== item.fingerprint ||
          row.failing !== item.failing
        );
      });
      const absent = prior.filter(
        (row) =>
          row.active &&
          !observations.some((o) => o.code === row.code && (o.origin ?? 'live') === row.origin),
      );
      if (changed.length === 0 && absent.length === 0) return { alerts: prior, raised: [] };
      const statements: ScalarStatement[] = changed.map((item) => ({
        sql: `INSERT INTO audit_health (org_id, code, origin, fingerprint, revision, acknowledged_revision, active, failing)
          VALUES (?, ?, ?, ?, ${nextRevision}, 0, ?, ?)
          ON CONFLICT (org_id, code, origin) DO UPDATE SET fingerprint = excluded.fingerprint,
            revision = CASE WHEN audit_health.active = 1 AND excluded.active = 0
              THEN audit_health.revision ELSE excluded.revision END,
            active = excluded.active, failing = excluded.failing
          WHERE audit_health.active != excluded.active OR audit_health.fingerprint != excluded.fingerprint
            OR audit_health.failing != excluded.failing
          RETURNING code, revision, active, origin`,
        params: [
          ctx.orgId,
          item.code,
          item.origin ?? 'live',
          item.fingerprint,
          ctx.orgId,
          item.code,
          Number(item.active !== false),
          Number(item.failing),
        ],
      }));
      for (const row of absent)
        statements.push({
          sql: `UPDATE audit_health SET active = 0, failing = 0 WHERE org_id = ? AND code = ? AND origin = ? AND active = 1 RETURNING code`,
          params: [ctx.orgId, row.code, row.origin],
        });
      statements.push({ sql: healthSelect, params: [ctx.orgId] });
      const results = await executor.batch(statements);
      return {
        raised: [
          ...new Set(
            results.slice(0, changed.length).flatMap((result) =>
              result.rows
                .filter((row) => {
                  const old = prior.find(
                    (r) => r.code === row['code'] && r.origin === row['origin'],
                  );
                  return old === undefined || Number(row['revision']) > old.revision;
                })
                .map((row) => row['code'] as AuditAlertCode),
            ),
          ),
        ],
        alerts: results.at(-1)!.rows.map(stored),
      };
    },
    async acknowledge(ctx, code, revision) {
      if (!AUDIT_ALERT_CODES.includes(code) || !Number.isSafeInteger(revision) || revision < 1)
        throw new TypeError('Invalid audit health acknowledgement');
      const rows = await executor.all({
        sql: `UPDATE audit_health SET acknowledged_revision = revision
          WHERE org_id = ? AND code = ? AND acknowledged_revision < revision
            AND (SELECT max(h.revision) FROM audit_health h WHERE h.org_id = ? AND h.code = ?) = ?
          RETURNING code`,
        params: [ctx.orgId, code, ctx.orgId, code, revision],
      });
      return rows.length > 0;
    },
  };
}
