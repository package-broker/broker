import {
  AUDIT_ALERT_CODES,
  AuditHealthConflictError,
  type AuditAlertCode,
  type AuditHealthPort,
  type AuditHealthSnapshot,
  type AuditHealthObservation,
  type AuditHealthStoredAlert,
} from '@package-broker/core/audit/health';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import { isUlid, ulid } from '@package-broker/core/ids';
import type { OrgContext } from '@package-broker/core/db/port';
import { auditPendingStatement } from './audit-pending.js';
import { assertCheck } from '../kysely.js';

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

function members(fingerprint: string): Set<string> {
  return new Set(fingerprint.split('|'));
}

/** A live condition that only lost members is the same incident; a new member is a new one. */
function newOccurrence(
  row: AuditHealthStoredAlert | undefined,
  item: AuditHealthObservation,
): boolean {
  if (row === undefined) return true;
  if (row.active && item.active === false) return false;
  if (!row.active || (item.origin ?? 'live') !== 'live') return true;
  const before = members(row.fingerprint);
  const after = members(item.fingerprint);
  return after.size >= before.size || [...after].some((member) => !before.has(member));
}

export interface AuditAlertOperator {
  readonly actor: AuditEvent['actor'] & { readonly type: 'user' | 'service_principal' };
  readonly generation: number;
  readonly now: Date;
}

export function createAuditHealthRepository(
  executor: ScalarSqlExecutor,
  operator?: AuditAlertOperator,
): AuditHealthPort & {
  operatorStatus(
    ctx: OrgContext,
  ): Promise<'ready' | 'actor_unavailable' | 'stale' | 'generation_ahead'>;
} {
  if (
    operator &&
    (!Number.isSafeInteger(operator.generation) ||
      operator.generation < 0 ||
      !['user', 'service_principal'].includes(operator.actor.type) ||
      operator.actor.id === null ||
      (!isUlid(operator.actor.id) &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operator.actor.id)))
  )
    throw new TypeError('Invalid audit alert operator');
  const actorTable = operator?.actor.type === 'user' ? 'user_account' : 'service_principal';
  return {
    async operatorStatus(ctx) {
      if (!operator) throw new TypeError('Audit alert operator required');
      const [actor, generation] = await executor.batch([
        {
          sql: `SELECT 1 FROM ${actorTable} WHERE org_id = ? AND id = ? AND status = 'active'`,
          params: [ctx.orgId, operator.actor.id],
        },
        {
          sql: 'SELECT coalesce(max(generation), 0) AS generation FROM audit_sink WHERE org_id = ?',
          params: [ctx.orgId],
        },
      ]);
      if (actor!.rows.length !== 1) return 'actor_unavailable';
      const highest = Number(generation!.rows[0]!['generation']);
      return operator.generation < highest
        ? 'stale'
        : operator.generation > highest
          ? 'generation_ahead'
          : 'ready';
    },
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
          sql: 'SELECT sink_id AS id, state, blocked_reason AS blockedReason, activation_source AS activationSource FROM audit_sink WHERE org_id = ?',
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
      const key = (code: string, origin: string) => `${code}\u0000${origin}`;
      const byKey = new Map(prior.map((row) => [key(row.code, row.origin), row]));
      const changed = observations.filter((item) => {
        const row = byKey.get(key(item.code, item.origin ?? 'live'));
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
      const latest = new Map<AuditAlertCode, number>();
      for (const row of prior)
        latest.set(row.code, Math.max(latest.get(row.code) ?? 0, row.revision));
      const writes = changed.map((item) => {
        const row = byKey.get(key(item.code, item.origin ?? 'live'));
        const occurrence = newOccurrence(row, item);
        const revision = occurrence ? (latest.get(item.code) ?? 0) + 1 : row!.revision;
        if (occurrence) latest.set(item.code, revision);
        return { item, occurrence, revision };
      });
      const statements: ScalarStatement[] = [
        ...(assertCheck(sql`((SELECT count(*) FROM audit_health WHERE org_id = ${ctx.orgId}) = ${prior.length}
          AND NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(
            prior.map((row) => [
              row.code,
              row.origin,
              row.fingerprint,
              row.revision,
              Number(row.active),
              Number(row.failing),
            ]),
          )}) e WHERE NOT EXISTS (SELECT 1 FROM audit_health h WHERE h.org_id = ${ctx.orgId}
            AND h.code = json_extract(e.value, '$[0]') AND h.origin = json_extract(e.value, '$[1]')
            AND h.fingerprint = json_extract(e.value, '$[2]') AND h.revision = json_extract(e.value, '$[3]')
            AND h.active = json_extract(e.value, '$[4]') AND h.failing = json_extract(e.value, '$[5]'))))`) as readonly ScalarStatement[]),
      ];
      for (const { item, revision } of writes)
        statements.push({
          sql: `INSERT INTO audit_health (org_id, code, origin, fingerprint, revision, acknowledged_revision, active, failing)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT (org_id, code, origin) DO UPDATE SET fingerprint = excluded.fingerprint,
            revision = excluded.revision, active = excluded.active, failing = excluded.failing
          RETURNING code`,
          params: [
            ctx.orgId,
            item.code,
            item.origin ?? 'live',
            item.fingerprint,
            revision,
            Number(item.active !== false),
            Number(item.failing),
          ],
        });
      for (const row of absent)
        statements.push({
          sql: `UPDATE audit_health SET active = 0, failing = 0 WHERE org_id = ? AND code = ? AND origin = ? AND active = 1 RETURNING code`,
          params: [ctx.orgId, row.code, row.origin],
        });
      statements.push({ sql: healthSelect, params: [ctx.orgId] });
      let results;
      try {
        results = await executor.batch(statements);
      } catch (error) {
        if (
          error instanceof DbError &&
          error.kind === 'unique' &&
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
        )
          throw new AuditHealthConflictError();
        throw error;
      }
      return {
        raised: [...new Set(writes.filter((w) => w.occurrence).map((w) => w.item.code))],
        alerts: results.at(-1)!.rows.map(stored),
      };
    },
    async acknowledge(ctx, code, revision) {
      if (!AUDIT_ALERT_CODES.includes(code) || !Number.isSafeInteger(revision) || revision < 0)
        throw new TypeError('Invalid audit health acknowledgement');
      const update: ScalarStatement = {
        sql: `UPDATE audit_health SET acknowledged_revision = revision
          WHERE org_id = ? AND code = ? AND acknowledged_revision < revision
            AND (SELECT max(h.revision) FROM audit_health h WHERE h.org_id = ? AND h.code = ?) = ?
          RETURNING code`,
        params: [ctx.orgId, code, ctx.orgId, code, revision],
      };
      if (!operator) return (await executor.all(update)).length > 0;
      const event = auditEvent({
        id: ulid(),
        now: operator.now.toISOString(),
        action: 'audit.sink_admin',
        actor: operator.actor,
        context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        target: { type: 'organization', id: ctx.orgId },
        changes: {
          operation: { new: 'alert_ack' },
          alert_code: { new: code },
          revision: { new: revision },
        },
      });
      if (!event.ok) throw new TypeError('Audit alert control event refused');
      const guards = assertCheck(sql`(EXISTS (SELECT 1 FROM ${sql.table(actorTable)}
        WHERE org_id = ${ctx.orgId} AND id = ${operator.actor.id} AND status = 'active')
        AND (SELECT coalesce(max(generation), 0) FROM audit_sink WHERE org_id = ${ctx.orgId}) = ${operator.generation})`) as readonly ScalarStatement[];
      const pending = auditPendingStatement(ctx, event.event, {
        sql: `EXISTS (SELECT 1 FROM audit_health WHERE org_id = ? AND code = ? AND acknowledged_revision < revision)
          AND (SELECT max(h.revision) FROM audit_health h WHERE h.org_id = ? AND h.code = ?) = ?`,
        params: [ctx.orgId, code, ctx.orgId, code, revision],
      }) as ScalarStatement;
      try {
        const results = await executor.batch([
          ...guards,
          { ...pending, sql: `${pending.sql} RETURNING id` },
          update,
        ]);
        return results.at(-1)!.rows.length > 0;
      } catch (error) {
        if (
          error instanceof DbError &&
          error.kind === 'unique' &&
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
        )
          throw new AuditHealthConflictError();
        throw error;
      }
    },
  };
}
