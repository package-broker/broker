import { sql, type RawBuilder } from 'kysely';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { UnpublishStore } from '@package-broker/core/registry/npm/unpublish';
import { compareNpmVersions } from '@package-broker/core/catalogue/versions';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { assertPublishBinding } from './catalogue-publish-guard.js';
import { auditPendingStatement } from './audit-pending.js';

const statement = (query: RawBuilder<unknown>): Statement =>
  compile({ compile: () => query.compile(db) });

export function createUnpublishStore(executor: SqlExecutor): UnpublishStore {
  return {
    async tarballRemoved(ctx, sourceId, key, file, revision) {
      const rows = await executor.all<{ file: string }>(
        statement(sql`select v.version as file
        from version v join package p on p.id=v.package_id and p.org_id=${ctx.orgId}
        join source s on s.id=p.source_id and s.org_id=${ctx.orgId}
        where v.org_id=${ctx.orgId} and p.name=${key} and p.ecosystem='npm' and p.source_id=${sourceId}
        and p.rev=${revision} and s.type='hosted' and s.status='active' and v.status='tombstoned'`),
      );
      const base = key.slice(key.lastIndexOf('/') + 1);
      return rows.some((row) => `${base}-${row.file}.tgz` === file);
    },
    async remove(ctx, guard, input) {
      assertPublishBinding(ctx, guard, input, true);
      const { snapshot } = input;
      if (
        !input.versions.length ||
        new Set(input.versions).size !== input.versions.length ||
        input.versions.some((v) => !snapshot.versions.some((row) => row.version === v))
      )
        throw new TypeError('invalid unpublish snapshot');
      const removed = snapshot.versions.filter((v) => input.versions.includes(v.version));
      const remaining = snapshot.versions
        .filter((v) => !input.versions.includes(v.version))
        .sort((a, b) => compareNpmVersions(b.version, a.version));
      if (input.whole && remaining.length) throw new TypeError('invalid whole unpublish');
      const next = remaining[0];
      const opId = newOpId();
      const statements: Statement[] = [
        ...guard,
        ...assertCheck(sql<boolean>`exists (
        select 1 from package p join source s on s.id=p.source_id and s.org_id=${ctx.orgId}
        where p.org_id=${ctx.orgId} and p.id=${snapshot.packageId} and p.rev=${snapshot.rev}
        and p.source_id=${input.sourceId} and p.name=${input.key} and p.ecosystem='npm'
        and s.type='hosted' and s.status='active')`),
      ];
      if (input.whole)
        statements.push(
          ...assertCheck(sql<boolean>`(
        select count(*) from version where org_id=${ctx.orgId} and package_id=${snapshot.packageId} and status<>'tombstoned')=${removed.length}`),
        );
      const records = removed.map((v) => ({
        id: v.id,
        revision: v.revision,
        revisionId: newOpId(),
      }));
      const json = JSON.stringify(records);
      const eligible = sql<boolean>`v.org_id=${ctx.orgId} and v.package_id=${snapshot.packageId}
        and v.id=json_extract(edit.value,'$.id') and v.revision=json_extract(edit.value,'$.revision') and v.status='active'
        and not exists (select 1 from publish_approval pa where pa.org_id=${ctx.orgId} and pa.version_id=v.id
          and (pa.approval_state='pending' or pa.scan_state in ('queued','running','failed')))`;
      statements.push(
        ...assertCheck(sql<boolean>`(not exists (select 1 from json_each(${json}) edit where not exists (
        select 1 from version v where ${eligible}
        and unixepoch(v.published_at,'subsec') between unixepoch('now','subsec')-259200 and unixepoch('now','subsec'))))`),
        statement(sql`insert into version_revision (id,org_id,version_id,revision,blob_id,source_ref,metadata_json,reason,op_id)
          select json_extract(edit.value,'$.revisionId'),v.org_id,v.id,v.revision,v.blob_id,v.source_ref,v.metadata_json,'npm_unpublish',${opId}
          from json_each(${json}) edit join version v on ${eligible}`),
        statement(sql`update version as v set status='tombstoned',tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          tombstone_reason='npm_unpublish',purge_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' ||
            (select max(o.retention_removed_upstream_days,coalesce(s.retention_days_override,0)) from organization o
            join source s on s.org_id=o.id where o.id=${ctx.orgId} and s.id=${input.sourceId}) || ' days'),
          revision=revision+1,last_op_id=${opId} where v.org_id=${ctx.orgId} and v.package_id=${snapshot.packageId}
          and exists (select 1 from json_each(${json}) edit where ${eligible})`),
      );
      const history = Object.entries(snapshot.tags).flatMap(([tag, previous]) => {
        const old = removed.find((v) => v.version === previous);
        return old ? [{ id: newOpId(), tag, previous: old.id }] : [];
      });
      statements.push(
        statement(sql`insert into dist_tag_history (id,org_id,package_id,tag,version_id,previous_version_id,action,actor_type,actor_id,op_id)
        select json_extract(tag.value,'$.id'),${ctx.orgId},${snapshot.packageId},json_extract(tag.value,'$.tag'),${next?.id ?? null},
          json_extract(tag.value,'$.previous'),${next ? 'set' : 'remove'},${input.event.actor.type},${input.event.actor.id},${opId}
        from json_each(${JSON.stringify(history)}) tag`),
      );
      const pointsAtRemoved = sql<boolean>`org_id=${ctx.orgId} and package_id=${snapshot.packageId}
        and version_id in (select json_extract(edit.value,'$.id') from json_each(${json}) edit)`;
      statements.push(
        next
          ? statement(sql`update dist_tag set version_id=${next.id} where ${pointsAtRemoved}`)
          : statement(sql`delete from dist_tag where ${pointsAtRemoved}`),
      );
      statements.push(
        statement(
          sql`update package set rev=rev+1,modified_at=${monotonicNow} where org_id=${ctx.orgId} and id=${snapshot.packageId} and rev=${snapshot.rev}`,
        ),
        auditPendingStatement(ctx, input.event),
        statement(
          sql`update cache_epoch set version=hex(randomblob(16)) where org_id=${ctx.orgId}`,
        ),
      );
      await executor.batch(statements);
    },
  };
}
