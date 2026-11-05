import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { auditEvent } from '@package-broker/core/audit/actions';
import { systemClock, ulid } from '@package-broker/core/ids';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import { JobError, type CoreJobs } from '@package-broker/core/platform/jobs';
import { auditPendingStatement } from './audit-pending.js';

export function createNpmLoginExpiryRepository(executor: SqlExecutor) {
  return {
    async expire(ctx: OrgContext): Promise<number> {
      const rows = await executor.all<{ id: string; token_id: string | null; state: string }>({
        sql: "SELECT id, token_id, state FROM npm_login_session WHERE org_id = ? AND ((state <> 'delivering' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR (state = 'delivering' AND delivering_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))) AND NOT (state IN ('approved', 'delivering') AND EXISTS (SELECT 1 FROM token t WHERE t.org_id = npm_login_session.org_id AND t.id = npm_login_session.token_id AND t.revoked_at IS NULL AND (t.user_id IS NULL OR t.user_id <> npm_login_session.user_id))) ORDER BY expires_at, id LIMIT 50",
        params: [ctx.orgId],
      });
      let actedOn = 0;
      for (const row of rows) {
        const condition = {
          sql: "EXISTS (SELECT 1 FROM npm_login_session l JOIN token t ON t.org_id = l.org_id AND t.id = l.token_id AND t.user_id = l.user_id WHERE l.org_id = ? AND l.id = ? AND l.state IN ('approved', 'delivering') AND ((l.state <> 'delivering' AND l.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR (l.state = 'delivering' AND l.delivering_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))) AND t.revoked_at IS NULL)",
          params: [ctx.orgId, row.id],
        };
        const now = systemClock.now().toISOString();
        const op = ulid();
        const audit =
          row.token_id === null
            ? null
            : auditEvent({
                id: ulid(),
                now,
                action: 'token.revoke',
                actor: { type: 'system', id: null },
                context: { opId: op, requestId: op, sourceIp: null, tokenSelector: null },
                target: { type: 'token', id: row.token_id },
                projectId: null,
                changes: {
                  cause: {
                    new:
                      row.state === 'delivering'
                        ? 'login_delivery_unconfirmed'
                        : 'login_uncollected',
                  },
                },
              });
        if (audit !== null && !audit.ok) throw new TypeError('Invalid login expiry audit');
        const results = await executor.batch([
          ...(audit?.ok ? [auditPendingStatement(ctx, audit.event, condition)] : []),
          {
            sql: `UPDATE token SET revoked_at = ?, last_op_id = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL AND ${condition.sql} RETURNING id`,
            params: [now, op, ctx.orgId, row.token_id, ...condition.params],
          },
          {
            sql: "DELETE FROM npm_login_session WHERE org_id = ? AND id = ? AND ((state <> 'delivering' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR (state = 'delivering' AND delivering_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))) AND (state NOT IN ('approved', 'delivering') OR EXISTS (SELECT 1 FROM token t WHERE t.org_id = npm_login_session.org_id AND t.id = npm_login_session.token_id AND t.revoked_at IS NOT NULL)) RETURNING id",
            params: [ctx.orgId, row.id],
          },
        ]);
        if (results.slice(-2).some((result) => result.rows.length > 0)) actedOn++;
      }
      return actedOn;
    },
  };
}
export function createNpmLoginExpiryJob(executor: SqlExecutor, jobs: Pick<CoreJobs, 'enqueue'>) {
  const store = createNpmLoginExpiryRepository(executor);
  return registerCoreJob({
    name: 'npm-login-expire',
    version: 2,
    schedule: { everySeconds: 60 },
    maxAttempts: 3,
    validate(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Reflect.ownKeys(input).length !== 0
      )
        throw new JobError('invalid_payload');
      return {};
    },
    async handler(_input, context) {
      if (context.signal.aborted) throw new JobError('aborted');
      if ((await store.expire(context.org)) === 50) {
        await jobs.enqueue(
          context.org,
          'core:npm-login-expire:v2',
          {},
          { idempotencyKey: `npm-login-expire:${context.jobId}` },
        );
      }
    },
  });
}
