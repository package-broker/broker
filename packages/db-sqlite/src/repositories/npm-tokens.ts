import { sql } from 'kysely';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { NpmTokenAdapters } from '@package-broker/core/authz/token-read';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { compile, db, type ProtectedHolderProvider } from '../kysely.js';
import { tokenAccessCondition } from './access.js';
import { auditPendingStatement } from './audit-pending.js';
import { createTokenReader } from './token-read.js';

export function createNpmTokenAdapters(
  executor: SqlExecutor,
  anchors: (ctx: OrgContext) => Promise<readonly ProtectedHolderProvider[]>,
): NpmTokenAdapters {
  return {
    reader: createTokenReader(executor),
    async revokeOwn(ctx, input) {
      const live = tokenAccessCondition(
        ctx,
        {
          selector: input.selector,
          boundary: 'project',
          projectSlug: input.projectSlug,
          providerAnchors: await anchors(ctx),
        },
        sql<boolean>`pa.token_id = ${input.tokenId} and pa.user_id = ${input.userId}
        and pa.revoked_at is null and pa.expired = 0
        and pa.stamp_invalid = 0 and pa.validation_fresh = 1
        and pa.project_id = ${input.projectId}
        and json_array_length(pa.scopes_json) = 1
        and json_extract(pa.scopes_json, '$[0]') in ('read','write','full')
        and pa.read_only = (json_extract(pa.scopes_json, '$[0]') = 'read')
        and (exists (select 1 from json_each(json_extract(pa.access, '$.organization')) where value = 'project:read')
          or exists (select 1 from json_each(json_extract(pa.access, '$.project')) where value = 'project:read'))`,
      );
      const opId = ulid();
      const now = systemClock.now().toISOString();
      const audit = auditEvent({
        id: ulid(),
        now,
        action: 'token.revoke',
        actor: { type: 'user', id: input.userId },
        context: { opId, requestId: input.requestId, sourceIp: null, tokenSelector: null },
        target: { type: 'token', id: input.targetId },
        projectId: null,
      });
      if (!audit.ok) return false;
      const results = await executor.batch([
        compile(
          db
            .updateTable('token')
            .set({ revoked_at: now, last_op_id: opId })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.targetId)
            .where('kind', '=', 'pat')
            .where('user_id', '=', input.userId)
            .where('revoked_at', 'is', null)
            .where(live)
            .returning('id'),
        ),
        auditPendingStatement(ctx, audit.event, {
          sql: 'exists (select 1 from token where org_id = ? and id = ? and last_op_id = ?)',
          params: [ctx.orgId, input.targetId, opId],
        }),
      ]);
      return results[0]?.rows.length === 1;
    },
  };
}
