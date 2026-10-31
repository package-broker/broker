import { sql } from 'kysely';
import type { MutationFence } from '@package-broker/core/authz/fence';
import { fenceKind } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { trustedPublisherInput } from '@package-broker/core/api/routes/trusted-publishers-input';
import { trustedPublisherPrincipalName } from '@package-broker/core/api/routes/trusted-publishers-name';
import {
  TrustedPublisherError,
  type PublisherWrite,
  type TrustedPublisher,
  type TrustedPublisherStore,
} from '@package-broker/core/api/routes/trusted-publishers-store';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { auditPendingStatement } from './audit-pending.js';
import { disableTrustedPublisherStatements } from './workload-token.js';

function read(ctx: OrgContext) {
  return db
    .selectFrom('trusted_publisher as tp')
    .innerJoin('service_principal as sp', (join) =>
      join.onRef('sp.org_id', '=', 'tp.org_id').onRef('sp.id', '=', 'tp.service_principal_id'),
    )
    .select([
      'tp.id',
      'tp.package_name as packageName',
      'tp.repository_id as repositoryId',
      'tp.repository_owner_id as repositoryOwnerId',
      'tp.repository',
      'tp.workflow',
      'tp.environment',
      'tp.ref_pattern as refPattern',
      'tp.service_principal_id as servicePrincipalId',
      'sp.name as servicePrincipalName',
      'tp.created_by_user_id as createdByUserId',
      'tp.created_at as createdAt',
      'tp.disabled_at as disabledAt',
      'tp.last_used_at as lastUsedAt',
      'tp.revision',
    ])
    .where('tp.org_id', '=', ctx.orgId);
}
const probe = (guard: Guard) =>
  compile(db.selectNoFrom(sql<number>`(${guard}) is not 1`.as('failed')));

export function createTrustedPublisherStore(
  executor: SqlExecutor,
  anchors: readonly ProtectedHolderProvider[],
): TrustedPublisherStore {
  async function get(ctx: OrgContext, id: string): Promise<TrustedPublisher | null> {
    const [item] = await executor.all<Omit<TrustedPublisher, 'createdByName'>>(
      compile(read(ctx).where('tp.id', '=', id)),
    );
    return item === undefined ? null : { ...item, createdByName: 'User' };
  }
  function authority(ctx: OrgContext, fence: MutationFence): Guard {
    if (fenceKind(fence) !== 'session') throw new TrustedPublisherError('forbidden');
    const holds = (permission: string) =>
      actorHolds(ctx, fence, { permission, projectId: null, providerAnchors: anchors });
    return sql<boolean>`(${holds('org:packages:publish')} and ${holds('org:service-principals:write')})`;
  }
  async function run(
    ctx: OrgContext,
    fence: MutationFence,
    held: Guard,
    ready: Guard,
    mutations: readonly Statement[],
    checks: { claim?: Guard; unique?: Guard } = {},
  ) {
    const outcome = await runOrgFenced(
      executor,
      ctx,
      fence,
      assertGuard(sql<boolean>`(${held} and ${ready})`, ctx),
      mutations,
      { authority: probe(held), conflict: probe(ready) },
    );
    if (outcome.ok) return;
    if (outcome.reason === 'authority') throw new TrustedPublisherError('forbidden');
    for (const [name, check] of Object.entries(checks)) {
      const [result] = await executor.all<{ failed: number }>(probe(check));
      if (result?.failed !== 0)
        throw new TrustedPublisherError(
          name === 'claim' ? 'name_not_claimed' : 'ambiguous_trusted_publisher',
        );
    }
    throw new TrustedPublisherError(
      outcome.reason === 'conflict' || outcome.reason === 'collision' ? 'conflict' : 'unavailable',
    );
  }
  async function validated(write: PublisherWrite) {
    let input;
    let name;
    try {
      input = trustedPublisherInput(write.input);
      name = await trustedPublisherPrincipalName(
        input.repository,
        input.workflow,
        input.packageName,
        input.environment,
      );
    } catch {
      throw new TrustedPublisherError('invalid_request');
    }
    if (
      !/^[1-9][0-9]{0,19}$/.test(write.identity.repositoryId) ||
      !/^[1-9][0-9]{0,19}$/.test(write.identity.repositoryOwnerId) ||
      write.identity.repository.toLowerCase() !== input.repository ||
      !Number.isFinite(Date.parse(write.now)) ||
      new Date(write.now).toISOString() !== write.now
    )
      throw new TrustedPublisherError('invalid_request');
    return { input, name };
  }

  function checks(ctx: OrgContext, write: PublisherWrite, id: string) {
    const input = write.input;
    const wildcard = input.packageName.startsWith('@')
      ? input.packageName.split('/')[0] + '/*'
      : input.packageName;
    const claim = sql<boolean>`exists (select 1 from source s join registered_name rn on rn.source_id = s.id and rn.org_id = s.org_id
      where s.org_id = ${ctx.orgId} and s.type = 'hosted' and s.ecosystem = 'npm' and s.project_id is null and s.status = 'active'
      and rn.ecosystem = 'npm' and rn.pattern in (${input.packageName}, ${wildcard}))`;
    const unique = sql<boolean>`not exists (select 1 from trusted_publisher other where other.org_id = ${ctx.orgId} and other.id <> ${id}
      and other.package_name = ${input.packageName} and other.repository_id = ${write.identity.repositoryId}
      and other.workflow = ${input.workflow} and lower(other.environment) = ${input.environment})`;
    return { claim, unique };
  }
  return {
    get,
    async list(ctx) {
      const rows = await executor.all<Omit<TrustedPublisher, 'createdByName'>>(
        compile(read(ctx).orderBy('tp.id')),
      );
      return { items: rows.map((item) => ({ ...item, createdByName: 'User' })) };
    },
    async create(ctx, fence, write) {
      const { input, name } = await validated(write);
      const held = authority(ctx, fence);
      const c = checks(ctx, { ...write, input }, write.id);
      await run(
        ctx,
        fence,
        held,
        sql<boolean>`(${c.claim} and ${c.unique})`,
        [
          compile(
            db.insertInto('service_principal').values({
              id: write.principalId,
              org_id: ctx.orgId,
              name,
              created_by_user_id: fence.userId,
              project_id: null,
              status: 'active',
              revision: 1,
              created_at: write.now,
              updated_at: write.now,
            }),
          ),
          compile(
            db.insertInto('service_principal_permission').values({
              org_id: ctx.orgId,
              service_principal_id: write.principalId,
              permission: 'org:packages:publish',
            }),
          ),
          compile(
            db.insertInto('trusted_publisher').values({
              id: write.id,
              org_id: ctx.orgId,
              package_name: input.packageName,
              repository_id: write.identity.repositoryId,
              repository_owner_id: write.identity.repositoryOwnerId,
              repository: input.repository,
              workflow: input.workflow,
              environment: input.environment,
              ref_pattern: input.refPattern ?? null,
              service_principal_id: write.principalId,
              created_by_user_id: fence.userId,
              created_at: write.now,
              disabled_at: null,
              last_used_at: null,
              revision: 1,
            }),
          ),
          auditPendingStatement(ctx, write.event),
        ],
        c,
      );
      const item = await get(ctx, write.id);
      if (item === null) throw new TrustedPublisherError('unavailable');
      return item;
    },
    async update(ctx, fence, write) {
      const { input, name } = await validated(write);
      const held = authority(ctx, fence);
      const c = checks(ctx, { ...write, input }, write.id);
      if (!Number.isSafeInteger(write.expectedRevision) || write.expectedRevision < 1)
        throw new TrustedPublisherError('invalid_request');
      const ready = sql<boolean>`(${c.claim} and ${c.unique} and exists (select 1 from trusted_publisher tp where tp.org_id = ${ctx.orgId} and tp.id = ${write.id} and tp.disabled_at is null and tp.revision = ${write.expectedRevision}))`;
      await run(
        ctx,
        fence,
        held,
        ready,
        [
          compile(
            db
              .updateTable('trusted_publisher')
              .set({
                package_name: input.packageName,
                repository_id: write.identity.repositoryId,
                repository_owner_id: write.identity.repositoryOwnerId,
                repository: input.repository,
                workflow: input.workflow,
                environment: input.environment,
                ref_pattern: input.refPattern ?? null,
                revision: sql`revision + 1`,
              })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', write.id)
              .where('revision', '=', write.expectedRevision)
              .where('disabled_at', 'is', null),
          ),
          ...assertCheck(sql<boolean>`changes() = 1`),
          compile(
            db
              .updateTable('service_principal')
              .set({ name, revision: sql`revision + 1`, updated_at: write.now })
              .where('org_id', '=', ctx.orgId)
              .where(
                'id',
                'in',
                db
                  .selectFrom('trusted_publisher')
                  .select('service_principal_id')
                  .where('org_id', '=', ctx.orgId)
                  .where('id', '=', write.id),
              ),
          ),
          auditPendingStatement(ctx, write.event),
        ],
        c,
      );
      const item = await get(ctx, write.id);
      if (item === null) throw new TrustedPublisherError('unavailable');
      return item;
    },
    async disable(ctx, fence, write) {
      const held = authority(ctx, fence);
      const ready = sql<boolean>`exists (select 1 from trusted_publisher tp where tp.org_id = ${ctx.orgId} and tp.id = ${write.id} and tp.revision = ${write.expectedRevision} and tp.disabled_at is null)`;
      await run(
        ctx,
        fence,
        held,
        ready,
        disableTrustedPublisherStatements(ctx, { ...write, audit: write.event }),
      );
    },
  };
}

export function createTrustedPublisherLookup(
  executor: SqlExecutor,
  lookup: (
    ctx: OrgContext,
    sourceId: string,
    repository: string,
    signal: AbortSignal,
  ) => Promise<
    import('@package-broker/core/api/routes/trusted-publishers-store').RepositoryIdentity | null
  >,
) {
  return async (ctx: OrgContext, repository: string, signal: AbortSignal) => {
    const rows = await executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('source')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('project_id', 'is', null)
          .where('type', '=', 'vcs')
          .where('status', '!=', 'paused')
          .where('credential_id', 'is not', null)
          .where(
            sql<boolean>`json_extract(config_json, '$.provider') = 'github' and lower(json_extract(config_json, '$.repository')) = ${repository.toLowerCase()}`,
          )
          .orderBy('id')
          .limit(1),
      ),
    );
    if (rows[0] === undefined) return null;
    return lookup(ctx, rows[0].id, repository, signal);
  };
}
