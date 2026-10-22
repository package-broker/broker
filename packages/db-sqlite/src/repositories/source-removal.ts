import { sql } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { RemovalRefusal } from '@package-broker/core/db/source';
import { compile, db } from '../kysely.js';
import { NOW } from '../internal/lease-time.js';

export function acceptRemovalStatement(
  ctx: OrgContext,
  input: { readonly sourceId: string; readonly refusal: RemovalRefusal },
): Statement {
  const { refusal } = input;
  return compile({
    compile: () =>
      sql`UPDATE source SET removal_accepted = 1, updated_at = ${NOW}
      WHERE org_id = ${ctx.orgId} AND id = ${input.sourceId} AND removal_accepted = 0
        AND last_refusal_at = ${refusal.at} AND last_refusal_absent = ${refusal.absent}
        AND last_refusal_listed = ${refusal.listed}
        AND last_refusal_successful = ${refusal.successful} AND last_refusal_successful > 0`.compile(
        db,
      ),
  });
}
