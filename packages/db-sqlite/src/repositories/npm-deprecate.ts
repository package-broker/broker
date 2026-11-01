import { sql, type RawBuilder } from 'kysely';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  DeprecationStore,
  DeprecationVersion,
} from '@package-broker/core/registry/npm/deprecate';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { assertPublishBinding } from './catalogue-publish-guard.js';
import { assertAuditPendingEvent } from './audit-pending.js';

const statement = (query: RawBuilder<unknown>): Statement =>
  compile({ compile: () => query.compile(db) });

export function createDeprecationStore(executor: SqlExecutor): DeprecationStore {
  return {
    async snapshot(ctx, sourceId, key) {
      const rows = await executor.all<
        DeprecationVersion & {
          packageId: string;
          rev: number;
          createdAt: string;
          modifiedAt: string;
          tags: string;
          inactive: number;
        }
      >(
        statement(sql`select p.id as packageId, p.rev, p.created_at as createdAt,
        p.modified_at as modifiedAt, v.id, v.revision, v.version,
        v.published_at as publishedAt, v.metadata_json as metadataJson,
        v.npm_integrity as npmIntegrity, v.deprecated_message as deprecatedMessage,
        (select json_group_object(t.tag, tv.version) from dist_tag t
          join version tv on tv.id = t.version_id and tv.org_id = ${ctx.orgId} and tv.status = 'active'
          where t.org_id = ${ctx.orgId} and t.package_id = p.id) as tags,
        (select count(*) from version iv where iv.org_id = ${ctx.orgId} and iv.package_id = p.id
          and iv.status not in ('active', 'tombstoned')) as inactive
        from package p join source s on s.id = p.source_id and s.org_id = ${ctx.orgId}
        join version v on v.package_id = p.id and v.org_id = ${ctx.orgId}
        where p.org_id = ${ctx.orgId} and p.source_id = ${sourceId} and p.name = ${key}
          and p.ecosystem = 'npm' and s.type = 'hosted' and s.status = 'active'
          and v.status = 'active' order by v.version`),
      );
      const first = rows[0];
      return first
        ? {
            packageId: first.packageId,
            rev: first.rev,
            createdAt: first.createdAt,
            modifiedAt: first.modifiedAt,
            tags: JSON.parse(first.tags) as Record<string, string>,
            versions: rows,
            inactive: first.inactive,
          }
        : null;
    },
    async update(ctx, guard, input) {
      assertPublishBinding(ctx, guard, input, true);
      const { snapshot, edits } = input;
      const opId = newOpId();
      const statements: Statement[] = [
        ...guard,
        ...assertCheck(sql<boolean>`exists (
        select 1 from package p join source s on s.id = p.source_id and s.org_id = ${ctx.orgId}
        where p.org_id = ${ctx.orgId} and p.id = ${snapshot.packageId} and p.rev = ${snapshot.rev}
          and p.source_id = ${input.sourceId} and p.name = ${input.key} and p.ecosystem = 'npm'
          and s.type = 'hosted' and s.status = 'active')`),
      ];
      if (new Set(edits.map((edit) => edit.version)).size !== edits.length)
        throw new TypeError('invalid deprecation snapshot');
      const records = edits.map((change) => {
        const version = snapshot.versions.find((v) => v.version === change.version);
        if (!version || change.old !== version.deprecatedMessage)
          throw new TypeError('invalid deprecation snapshot');
        assertAuditPendingEvent(change.event);
        return {
          id: version.id,
          revision: version.revision,
          old: change.old,
          message: change.message,
          event: change.event,
          revisionId: newOpId(),
        };
      });
      const json = JSON.stringify(records);
      const eligible = sql<boolean>`v.org_id=${ctx.orgId} and v.package_id=${snapshot.packageId}
        and v.id=json_extract(edit.value,'$.id') and v.revision=json_extract(edit.value,'$.revision')
        and v.status='active' and v.deprecated_message is json_extract(edit.value,'$.old')`;
      statements.push(
        ...assertCheck(sql<boolean>`not exists (select 1 from json_each(${json}) edit
        where not exists (select 1 from version v where ${eligible}))`),
      );
      if (edits.length)
        statements.push(
          statement(sql`insert into version_revision (id,org_id,version_id,revision,blob_id,source_ref,metadata_json,reason,op_id)
          select json_extract(edit.value,'$.revisionId'),v.org_id,v.id,v.revision,v.blob_id,v.source_ref,
            json_set(v.metadata_json,'$.deprecated',v.deprecated_message),'npm_deprecate',${opId}
          from json_each(${json}) edit join version v on ${eligible}`),
          statement(sql`update version as v set deprecated_message=(select json_extract(edit.value,'$.message')
            from json_each(${json}) edit where v.id=json_extract(edit.value,'$.id')),
          revision=revision+1,last_op_id=${opId}
          where v.org_id=${ctx.orgId} and v.package_id=${snapshot.packageId}
          and exists (select 1 from json_each(${json}) edit where ${eligible})`),
          statement(sql`insert into audit_pending (id,org_id,created_at,actor_type,actor_id,token_selector,source_ip,action,target_type,target_id,project_id,payload_json)
          select json_extract(edit.value,'$.event.id'),${ctx.orgId},json_extract(edit.value,'$.event.occurredAt'),
            json_extract(edit.value,'$.event.actor.type'),json_extract(edit.value,'$.event.actor.id'),
            json_extract(edit.value,'$.event.tokenSelector'),json_extract(edit.value,'$.event.sourceIp'),
            json_extract(edit.value,'$.event.action'),json_extract(edit.value,'$.event.target.type'),json_extract(edit.value,'$.event.target.id'),
            json_extract(edit.value,'$.event.projectId'),json_extract(edit.value,'$.event.payloadJson') from json_each(${json}) edit`),
        );
      if (edits.length)
        statements.push(
          statement(sql`update package set rev = rev + 1, modified_at = ${monotonicNow}
          where org_id = ${ctx.orgId} and id = ${snapshot.packageId} and rev = ${snapshot.rev}`),
          statement(
            sql`update cache_epoch set version = hex(randomblob(16)) where org_id = ${ctx.orgId}`,
          ),
        );
      await executor.batch(statements);
    },
  };
}
