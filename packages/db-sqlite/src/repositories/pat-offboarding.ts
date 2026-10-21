import { sql } from 'kysely';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { PatOffboardingStore } from '@package-broker/core/authz/pat-offboarding';
import type { PatOffboardingSweepStore } from '@package-broker/core/authz/pat-offboarding-sweep';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { isUlid } from '@package-broker/core/ids';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, assertCheck } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';

const MAX_PAGE = 25;
const MAX_SWEEP = 100;
const MAX_TEXT = 512;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function instant(field: string, value: unknown): string {
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  return value;
}

function text(field: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (value === '' && !allowEmpty) || value.length > MAX_TEXT) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${String(MAX_TEXT)} characters`,
    );
  }
  return value;
}

function limitOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new RangeError(`limit must be an integer from 1 to ${String(MAX_PAGE)}`);
  }
  return value;
}

function sweepLimitOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_SWEEP) {
    throw new RangeError(`limit must be an integer from 1 to ${String(MAX_SWEEP)}`);
  }
  return value;
}

function fenceOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('fence must be a positive integer');
  }
  return value;
}

function checkParameters(statement: Statement): Statement {
  if (statement.params.length > 100) throw new RangeError('statement exceeds 100 parameters');
  return statement;
}

const SELECTED_PROJECTS_UNHELD = `AND token.project_mode = 'selected'
  AND NOT EXISTS (
    SELECT 1 FROM token_project AS bound
    WHERE bound.org_id = token.org_id AND bound.token_id = token.id
      AND EXISTS (
        SELECT 1 FROM user_account AS owner
        JOIN access_grant AS reach ON reach.org_id = owner.org_id
        WHERE owner.org_id = token.org_id AND owner.id = token.user_id
          AND unixepoch(reach.created_at, 'subsec') <= unixepoch(?, 'subsec')
          AND (reach.scope = 'organization' OR reach.project_id = bound.project_id)
          AND (
            (reach.subject_type = 'email' AND reach.subject_value = owner.email)
            OR (reach.subject_type = 'group' AND EXISTS (
              SELECT 1 FROM user_group AS via
              WHERE via.org_id = owner.org_id AND via.user_id = owner.id
                AND via.provider = reach.subject_provider AND via.group_name = reach.subject_value
            ))
          )
      )
  )`;

export function createPatOffboardingRepository(
  executor: SqlExecutor,
): PatOffboardingStore & PatOffboardingSweepStore {
  return {
    async holdsAnyGrant(ctx, userId, cutoff) {
      const rows = await executor.all<{ held: number }>(
        checkParameters({
          sql: `SELECT EXISTS (
            SELECT 1 FROM user_account AS subject
            JOIN access_grant AS held ON held.org_id = subject.org_id
            WHERE subject.org_id = ? AND subject.id = ?
              AND unixepoch(held.created_at, 'subsec') <= unixepoch(?, 'subsec')
              AND (
                (held.subject_type = 'email' AND held.subject_value = subject.email)
                OR (held.subject_type = 'group' AND EXISTS (
                  SELECT 1 FROM user_group AS membership
                  WHERE membership.org_id = subject.org_id AND membership.user_id = subject.id
                    AND membership.provider = held.subject_provider
                    AND membership.group_name = held.subject_value
                ))
              )
          ) AS held`,
          params: [ctx.orgId, text('userId', userId), instant('cutoff', cutoff)],
        }),
      );
      const row = rows[0];
      if (row === undefined) throw new Error('grant lookup returned no row');
      return row.held === 1;
    },

    async suspendedUsersWithLivePats(ctx, afterId, limit) {
      const rows = await executor.all<{ id: string }>(
        checkParameters({
          sql: `SELECT u.id FROM user_account AS u
            WHERE u.org_id = ? AND u.id > ? AND u.status = 'suspended'
              AND EXISTS (
                SELECT 1 FROM token AS t
                WHERE t.org_id = u.org_id AND t.user_id = u.id
                  AND t.kind = 'pat' AND t.revoked_at IS NULL
              )
            ORDER BY u.id LIMIT ?`,
          params: [ctx.orgId, text('afterId', afterId, true), sweepLimitOf(limit)],
        }),
      );
      return rows.map((row) => row.id);
    },

    async candidates(ctx, { userId, cutoff, limit, selectedOnly, invalidatedTokenId }) {
      if (selectedOnly === true) {
        const at = instant('cutoff', cutoff);
        const rows = await executor.all<{ id: string }>(
          checkParameters({
            sql: `SELECT token.id FROM token
              WHERE token.org_id = ? AND token.kind = 'pat' AND token.user_id = ?
                AND token.revoked_at IS NULL
                AND unixepoch(token.created_at, 'subsec') <= unixepoch(?, 'subsec')
                ${invalidatedTokenId === undefined ? SELECTED_PROJECTS_UNHELD : "AND token.project_mode = 'selected' AND token.id = ?"}
              ORDER BY token.id LIMIT ?`,
            params: [
              ctx.orgId,
              text('userId', userId),
              at,
              invalidatedTokenId === undefined
                ? at
                : text('invalidatedTokenId', invalidatedTokenId),
              limitOf(limit),
            ],
          }),
        );
        return rows.map((row) => row.id);
      }
      const rows = await executor.all<{ id: string }>(
        checkParameters({
          sql: `SELECT id FROM token
            WHERE org_id = ? AND kind = 'pat' AND user_id = ? AND revoked_at IS NULL
              AND unixepoch(created_at, 'subsec') <= unixepoch(?, 'subsec')
            ORDER BY id LIMIT ?`,
          params: [ctx.orgId, text('userId', userId), instant('cutoff', cutoff), limitOf(limit)],
        }),
      );
      return rows.map((row) => row.id);
    },

    async revokePage(ctx, input) {
      const { ids, audits, lease } = input;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PAGE) {
        throw new RangeError(`a page revokes 1 to ${String(MAX_PAGE)} tokens`);
      }
      ids.forEach((id) => text('token id', id));
      if (new Set(ids).size !== ids.length) throw new TypeError('token ids must be distinct');
      const userId = text('userId', input.userId);
      const cutoff = instant('cutoff', input.cutoff);
      const now = instant('now', input.now);
      if (typeof input.opId !== 'string' || !isUlid(input.opId)) {
        throw new TypeError('opId must be a ULID');
      }
      const jobId = text('jobId', lease.jobId);
      const fence = fenceOf(lease.fence);
      if (
        !Array.isArray(audits) ||
        audits.length !== ids.length ||
        audits.some(
          (audit: AuditEvent, index) =>
            audit.action !== 'token.revoke' ||
            audit.target.type !== 'token' ||
            audit.target.id !== ids[index],
        )
      ) {
        throw new TypeError('audits must hold one token.revoke event per token id, in order');
      }

      const performed = (tokenId: string): { sql: string; params: readonly SqlValue[] } => ({
        sql: 'EXISTS (SELECT 1 FROM token WHERE org_id = ? AND id = ? AND last_op_id = ? AND revoked_at IS NOT NULL)',
        params: [ctx.orgId, tokenId, input.opId],
      });
      const update: Statement =
        input.selectedOnly === true
          ? {
              sql: `UPDATE token SET revoked_at = ?, last_op_id = ?
          WHERE token.org_id = ? AND token.kind = 'pat' AND token.user_id = ?
            AND token.revoked_at IS NULL
            AND unixepoch(token.created_at, 'subsec') <= unixepoch(?, 'subsec')
            AND token.id IN (SELECT value FROM json_each(?))
            ${input.invalidatedTokenId === undefined ? SELECTED_PROJECTS_UNHELD : "AND token.project_mode = 'selected' AND token.id = ?"}
          RETURNING id`,
              params: [
                now,
                input.opId,
                ctx.orgId,
                userId,
                cutoff,
                JSON.stringify(ids),
                input.invalidatedTokenId === undefined
                  ? cutoff
                  : text('invalidatedTokenId', input.invalidatedTokenId),
              ],
            }
          : {
              sql: `UPDATE token SET revoked_at = ?, last_op_id = ?
          WHERE org_id = ? AND kind = 'pat' AND user_id = ? AND revoked_at IS NULL
            AND unixepoch(created_at, 'subsec') <= unixepoch(?, 'subsec')
            AND id IN (SELECT value FROM json_each(?))
          RETURNING id`,
              params: [now, input.opId, ctx.orgId, userId, cutoff, JSON.stringify(ids)],
            };
      const statements = [
        ...assertCheck(
          sql<boolean>`EXISTS (SELECT 1 FROM job
            WHERE job.id = ${jobId} AND job.org_id = ${ctx.orgId} AND job.fence = ${fence}
              AND job.state = 'running'
              AND job.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ),
        update,
        ...audits.map((audit, index) =>
          auditPendingStatement(ctx, audit, performed(ids[index] as string)),
        ),
      ].map(checkParameters);
      const updateAt = statements.indexOf(update);

      try {
        const results = await executor.batch(statements);
        const rows = (results[updateAt]?.rows ?? []) as { id: string }[];
        return { status: 'ok', revoked: rows.map((row) => row.id).sort() };
      } catch (error) {
        if (!(error instanceof DbError)) throw error;
        if (error.kind === 'unique' && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT) {
          return 'lease_lost';
        }
        if (error.kind === 'unknown') return 'indeterminate';
        throw error;
      }
    },
  };
}

/**
 * Stamps the accounts behind a removed grant (the e-mail owner, or the stored members of a removed
 * group grant) with database time when no other grant of the organization, at any level and by
 * e-mail or stored group membership, still reaches them. `when` is trusted repository SQL that
 * binds the removed grant row to the caller's write.
 */
export function patInvalidationStatement(
  ctx: OrgContext,
  grantId: string,
  when: { readonly sql: string; readonly params: readonly SqlValue[] },
): Statement {
  return checkParameters({
    sql: `UPDATE user_account SET pat_invalid_before = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE org_id = ? AND (
        email IN (
          SELECT removed.subject_value FROM access_grant AS removed
          WHERE removed.id = ? AND removed.org_id = ? AND removed.subject_type = 'email' AND ${when.sql}
        )
        OR EXISTS (
          SELECT 1 FROM access_grant AS removed
          JOIN user_group AS removed_member ON removed_member.org_id = removed.org_id
            AND removed_member.provider = removed.subject_provider
            AND removed_member.group_name = removed.subject_value
          WHERE removed.id = ? AND removed.org_id = ? AND removed.subject_type = 'group' AND ${when.sql}
            AND removed_member.user_id = user_account.id
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM access_grant AS remaining
        WHERE remaining.org_id = user_account.org_id AND remaining.id <> ?
          AND (
            (remaining.subject_type = 'email' AND remaining.subject_value = user_account.email)
            OR (remaining.subject_type = 'group' AND EXISTS (
              SELECT 1 FROM user_group AS membership
              WHERE membership.org_id = user_account.org_id AND membership.user_id = user_account.id
                AND membership.provider = remaining.subject_provider
                AND membership.group_name = remaining.subject_value
            ))
          )
      )`,
    params: [
      ctx.orgId,
      grantId,
      ctx.orgId,
      ...when.params,
      grantId,
      ctx.orgId,
      ...when.params,
      grantId,
    ],
  });
}
