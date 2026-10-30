import { sql } from 'kysely';
import type {
  CatalogueWriteGuard,
  PublishVersionInput,
  PublishVersionResult,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { validateVersion } from '@package-broker/core/catalogue/versions';
import { MAX_METADATA_BYTES } from '@package-broker/core/catalogue/metadata';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { assertPublishBinding } from './catalogue-publish-guard.js';
import { coveredByRegisteredNames } from './registered-name.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { distTagStatements } from './catalogue-write-tags.js';
import { rederiveStatements } from './visibility-derive.js';
import { bindPackage } from './catalogue-writer.js';
import { auditPendingStatement } from './audit-pending.js';

export async function publishVersion(
  executor: SqlExecutor,
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  input: PublishVersionInput,
): Promise<PublishVersionResult> {
  assertPublishBinding(ctx, guard, input);
  const { version: v, approval: a } = input;
  const stability = validateVersion({
    ecosystem: 'npm',
    version: v.version,
    versionNormalized: v.versionNormalized,
  }).stability;
  if (new TextEncoder().encode(v.metadata.json).length > MAX_METADATA_BYTES)
    throw new RangeError('manifest_too_large');
  const tags = Object.entries(input.distTags);
  if (tags.length > 8) throw new RangeError('too_many_tags');
  if (tags.some(([, target]) => target !== v.version)) throw new TypeError('invalid_dist_tags');
  const held = { approval: input.requirePublishApproval, scan: a?.holdScan ?? false };
  const isHeld = held.approval || held.scan;
  if (isHeld !== (a !== null)) throw new TypeError('invalid_publish_hold: approval row presence');
  if (a) {
    if (a.holdApproval !== held.approval)
      throw new TypeError('invalid_publish_hold: approval hold flag');
    if (a.approvalState !== (held.approval ? 'pending' : 'not_required'))
      throw new TypeError('invalid_publish_hold: approval state');
    if (a.scanState !== (held.scan ? 'queued' : 'not_required'))
      throw new TypeError('invalid_publish_hold: scan state');
    if (a.versionId !== input.versionId)
      throw new TypeError('invalid_publish_hold: version binding');
    if (a.sourceId !== input.sourceId) throw new TypeError('invalid_publish_hold: source binding');
    if (a.tokenId !== input.tokenId) throw new TypeError('invalid_publish_hold: token binding');
    if (JSON.stringify(Object.entries(a.distTags).sort()) !== JSON.stringify([...tags].sort()))
      throw new TypeError('invalid_publish_hold: tag snapshot');
    if (held.scan && a.requiredScanners.length === 0)
      throw new TypeError('invalid_publish_hold: missing scanners');
    if (held.scan && input.scanJobStatements.length === 0)
      throw new TypeError('invalid_publish_hold: missing scan jobs');
  }
  if (!held.scan && input.scanJobStatements.length !== 0)
    throw new TypeError('invalid_publish_hold: unexpected scan jobs');
  const candidateId = newOpId();
  const opId = newOpId();
  const packageId = sql<string>`(select id from package where org_id = ${ctx.orgId}
    and source_id = ${input.sourceId} and ecosystem = 'npm' and name = ${input.key})`;
  const liveBlob = sql<string>`(select id from blob where org_id = ${ctx.orgId} and id = ${input.blob.id}
    and sha256 = ${input.blob.sha256} and size_bytes = ${input.blob.sizeBytes} and refetchable = 0
    and deleted_at is null and purge_lease_until is null)`;
  const fence = assertCheck(sql<boolean>`(exists (select 1 from project where org_id = ${ctx.orgId}
    and id = ${input.routeProjectId} and status = 'active') and exists (select 1 from source
      where org_id = ${ctx.orgId} and id = ${input.sourceId} and ecosystem = 'npm' and type = 'hosted'
      and project_id is null and status = 'active' and require_publish_approval = ${Number(input.requirePublishApproval)})
    and ${coveredByRegisteredNames(ctx, input.sourceId, 'npm', input.key)} and ${liveBlob} is not null)`);
  const statements: Statement[] = [
    ...guard,
    ...fence,
    compile(
      db
        .insertInto('package')
        .columns([
          'id',
          'org_id',
          'source_id',
          'ecosystem',
          'name',
          'description',
          'visible_to_new_projects',
          'last_synced_at',
          'held_until_active',
        ])
        .expression(
          db
            .selectFrom('source')
            .select([
              sql<string>`${candidateId}`.as('id'),
              'org_id',
              'id as source_id',
              sql<'npm'>`'npm'`.as('ecosystem'),
              sql<string>`${input.key}`.as('name'),
              sql<
                string | null
              >`${isHeld || input.distTags.latest !== v.version ? null : input.description}`.as(
                'description',
              ),
              'default_visible_to_new_projects',
              sql<string>`${input.now}`.as('last_synced_at'),
              sql<number>`${Number(isHeld)}`.as('held_until_active'),
            ])
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.sourceId),
        )
        .onConflict((oc) => oc.columns(['org_id', 'ecosystem', 'source_id', 'name']).doNothing()),
    ),
    ...rederiveStatements(ctx, { kind: 'package', packageId: candidateId }),
    compile(
      db.insertInto('version').values({
        id: input.versionId,
        org_id: ctx.orgId,
        package_id: packageId,
        version: v.version,
        version_normalized: v.versionNormalized,
        stability,
        status: isHeld ? 'quarantined' : 'active',
        published_at: input.now,
        published_at_basis: 'broker',
        upstream_released_at: null,
        license: v.license,
        dist_type: 'tgz',
        npm_integrity: input.integrity,
        source_ref: v.sourceRef,
        metadata_json: v.metadata.json,
        deprecated_message: v.metadata.deprecatedMessage,
        blob_id: liveBlob,
        last_op_id: opId,
      }),
    ),
    compile(
      db
        .updateTable('package')
        .set({
          rev: sql<number>`rev + 1`,
          modified_at: monotonicNow,
          ...(!isHeld
            ? {
                ...(input.distTags.latest === v.version ? { description: input.description } : {}),
                held_until_active: 0,
                last_synced_at: input.now,
              }
            : {}),
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', packageId),
    ),
  ];
  if (input.readme)
    statements.push(
      compile(
        db.insertInto('version_readme').values({
          org_id: ctx.orgId,
          version_id: input.versionId,
          filename: input.readme.filename,
          body: input.readme.body,
          created_at: input.now,
        }),
      ),
    );
  if (a)
    statements.push(
      compile(
        db.insertInto('publish_approval').values({
          id: a.id,
          org_id: ctx.orgId,
          package_id: packageId,
          version_id: input.versionId,
          source_id: input.sourceId,
          hold_approval: Number(held.approval),
          hold_scan: Number(held.scan),
          approval_state: a.approvalState,
          scan_state: a.scanState,
          required_scanners_json: JSON.stringify(a.requiredScanners),
          requested_by_type: a.requestedByType,
          requested_by_id: a.requestedById,
          token_id: input.tokenId,
          route_project_id: input.routeProjectId,
          dist_tags_json: JSON.stringify(input.distTags),
          readme_pending: Number(input.readme !== null),
          expires_at: a.expiresAt,
          created_at: input.now,
          updated_at: input.now,
        }),
      ),
    );
  const placeholder = newOpId();
  const plan = distTagStatements(ctx, guard, {
    packageId: placeholder,
    ecosystem: 'npm',
    tags: input.distTags,
    mode: 'patch',
    actorType: input.event.actor.type === 'service_principal' ? 'service' : 'user',
    actorId: input.event.actor.id,
    opId,
  });
  if (!isHeld) {
    for (const statement of plan.statements.slice(guard.length)) {
      statements.push(
        bindPackage(statement, placeholder, compile({ compile: () => packageId.compile(db) })),
      );
    }
  }
  statements.push(
    ...input.scanJobStatements,
    bindPackage(
      auditPendingStatement(
        ctx,
        input.event.target.type === 'package'
          ? { ...input.event, target: { ...input.event.target, id: placeholder } }
          : input.event,
        compile({
          compile: () =>
            sql<boolean>`exists (select 1 from version where org_id = ${ctx.orgId} and id = ${input.versionId} and last_op_id = ${opId})`.compile(
              db,
            ),
        }),
      ),
      placeholder,
      compile({ compile: () => packageId.compile(db) }),
    ),
    compile(
      db
        .selectFrom('package')
        .select(['id', 'rev'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', packageId),
    ),
  );
  if (statements.length > 40) throw new RangeError('publish batch budget exceeded');
  const results = await executor.batch(statements);
  const row = results.at(-1)?.rows[0];
  if (!row || typeof row.id !== 'string' || typeof row.rev !== 'number')
    throw new TypeError('missing publish result');
  return {
    packageId: row.id,
    versionId: input.versionId,
    rev: row.rev,
    approvalId: a?.id ?? null,
    held,
  };
}
