import { sql, type RawBuilder } from 'kysely';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { DistTagStore } from '@package-broker/core/registry/npm/dist-tags';
import { validDistTag } from '@package-broker/core/registry/npm/dist-tags';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { assertPublishBinding } from './catalogue-publish-guard.js';
import { auditPendingStatement } from './audit-pending.js';

const statement = (query: RawBuilder<unknown>): Statement =>
  compile({ compile: () => query.compile(db) });

export function createDistTagStore(executor: SqlExecutor): DistTagStore {
  return {
    async update(ctx, guard, input) {
      assertPublishBinding(ctx, guard, input, true);
      if (!validDistTag(input.tag) || (input.tag === 'latest' && input.version === null))
        throw new TypeError('invalid dist-tag mutation');
      const { snapshot, tag } = input;
      const target =
        input.version === null ? null : snapshot.versions.find((v) => v.version === input.version);
      if (target === undefined) throw new TypeError('invalid dist-tag target');
      if (target === null && !Object.hasOwn(snapshot.tags, tag))
        throw new TypeError('invalid dist-tag removal');
      const opId = newOpId();
      const statements: Statement[] = [
        ...guard,
        ...assertCheck(sql<boolean>`exists (
        select 1 from package p join source s on s.id=p.source_id and s.org_id=${ctx.orgId}
        where p.org_id=${ctx.orgId} and p.id=${snapshot.packageId} and p.rev=${snapshot.rev}
        and p.source_id=${input.sourceId} and p.name=${input.key} and p.ecosystem='npm'
        and s.type='hosted' and s.status='active')`),
      ];
      if (target !== null)
        statements.push(
          ...assertCheck(sql<boolean>`exists (
        select 1 from version v where v.org_id=${ctx.orgId} and v.package_id=${snapshot.packageId}
        and v.id=${target.id} and v.revision=${target.revision} and v.status='active'
        and not exists (select 1 from publish_approval pa where pa.org_id=${ctx.orgId} and pa.version_id=v.id
          and (pa.approval_state='pending' or pa.scan_state in ('queued','running','failed'))))`),
        );
      statements.push(
        statement(sql`insert into dist_tag_history
        (id,org_id,package_id,tag,version_id,previous_version_id,action,actor_type,actor_id,op_id)
        values (${newOpId()},${ctx.orgId},${snapshot.packageId},${tag},${target?.id ?? null},
          (select version_id from dist_tag where org_id=${ctx.orgId} and package_id=${snapshot.packageId} and tag=${tag}),
          ${target === null ? 'remove' : 'set'},${input.event.actor.type},${input.event.actor.id},${opId})`),
        statement(
          sql`delete from dist_tag where org_id=${ctx.orgId} and package_id=${snapshot.packageId} and tag=${tag}`,
        ),
      );
      if (target !== null)
        statements.push(
          statement(sql`insert into dist_tag (org_id,package_id,tag,version_id)
        values (${ctx.orgId},${snapshot.packageId},${tag},${target.id})`),
        );
      statements.push(
        statement(sql`update package set rev=rev+1, modified_at=${monotonicNow}
        where org_id=${ctx.orgId} and id=${snapshot.packageId} and rev=${snapshot.rev}`),
        auditPendingStatement(ctx, input.event),
        statement(
          sql`update cache_epoch set version=hex(randomblob(16)) where org_id=${ctx.orgId}`,
        ),
      );
      await executor.batch(statements);
    },
  };
}
