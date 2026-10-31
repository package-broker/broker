import { npmClaimCover } from './catalogue-predicates.js';
import { isNpmClaim } from '@package-broker/core/sources/claim-admission';
import { sql, type Expression, type SqlBool } from 'kysely';
import type { MutationFence } from '@package-broker/core/authz/fence';
import {
  MAX_PATTERN_BYTES,
  MAX_PATTERN_WILDCARDS,
  isValidPattern,
} from '@package-broker/core/catalogue/patterns';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  NewRegisteredName as CoreNewRegisteredName,
  RegisteredNameRepository as CoreRegisteredNameRepository,
  RegisteredNameRecord,
  RegisteredNameTarget as CoreRegisteredNameTarget,
} from '@package-broker/core/db/source';
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
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';

const PROXY_TYPES = ['packagist_proxy', 'npmjs_proxy'] as const;
const COMPOSER_PATTERN = /^[a-z0-9._*-]+\/[a-z0-9._*-]+$/;
const NPM_UNSCOPED_PATTERN = /^[a-z0-9._~!*-]+$/;
const NPM_SCOPED_PATTERN = /^@[a-z0-9._~!*-]+\/[a-z0-9._~!*-]+$/;

type SourceRef = string | Expression<string>;
type Ecosystem = 'composer' | 'npm';

export type NewRegisteredName = CoreNewRegisteredName;
export type RegisteredNameTarget = CoreRegisteredNameTarget;
export type RegisteredNameRepository = CoreRegisteredNameRepository;

export function isRegistrablePattern(pattern: string, ecosystem: Ecosystem): boolean {
  if (ecosystem === 'npm' && isNpmClaim(pattern)) return true;
  if (!isValidPattern(pattern)) return false;
  const body = pattern.startsWith('@') ? pattern.slice(1) : pattern;
  if (body.length === 0 || body.startsWith('*') || body.startsWith('/')) return false;
  if (ecosystem === 'composer') return COMPOSER_PATTERN.test(pattern);
  return pattern.startsWith('@')
    ? NPM_SCOPED_PATTERN.test(pattern)
    : NPM_UNSCOPED_PATTERN.test(pattern);
}

/** Proxies always; npm_registry when every configured scope has `@scope/*`; other types with one name. */
export function sourceActivatable(ctx: OrgContext, sourceId: SourceRef): Guard {
  return sql<SqlBool>`exists (select 1 from source as rn_act_s
    where rn_act_s.id = ${sourceId} and rn_act_s.org_id = ${ctx.orgId}
      and (rn_act_s.type in (${sql.join(PROXY_TYPES)})
        or (exists (select 1 from registered_name as rn_act_r
              where rn_act_r.source_id = rn_act_s.id and rn_act_r.org_id = rn_act_s.org_id)
          and (rn_act_s.type <> 'npm_registry' or not exists (
            select 1 from json_each(rn_act_s.config_json, '$.scopes') as rn_act_j
            where not exists (select 1 from registered_name as rn_act_c
              where rn_act_c.source_id = rn_act_s.id and rn_act_c.org_id = rn_act_s.org_id
                and rn_act_c.pattern = rn_act_j.value || '/*'))))))`;
}

/** Legacy globs are bounded to 50 bytes; npm claims use equality or scope-prefix matching. */
export function coveredByRegisteredNames(
  ctx: OrgContext,
  sourceId: SourceRef,
  ecosystem: Ecosystem | Expression<string>,
  key: string | Expression<string>,
): Guard {
  return sql<SqlBool>`exists (select 1 from registered_name as rn_cov
    where rn_cov.org_id = ${ctx.orgId} and rn_cov.source_id = ${sourceId}
      and rn_cov.ecosystem = ${ecosystem}
      and (${npmClaimCover(sql.ref('rn_cov.ecosystem'), sql.ref('rn_cov.pattern'), sql`${key}`)}
      or (case when rn_cov.pattern not glob '*[^a-z0-9._~@!/*-]*'
      and length(cast(rn_cov.pattern as blob)) = length(rn_cov.pattern)
      and length(rn_cov.pattern) between 1 and ${sql.lit(MAX_PATTERN_BYTES)}
      and length(rn_cov.pattern) - length(replace(rn_cov.pattern, '*', ''))
        <= ${sql.lit(MAX_PATTERN_WILDCARDS)}
        then ${key} glob rn_cov.pattern else 0 end)))`;
}

function probe(condition: Guard, negate: boolean): Statement {
  const expression = negate ? sql<number>`(${condition}) is not 1` : sql<number>`(${condition})`;
  return compile(db.selectNoFrom(expression.as('held')));
}

function allOf(conditions: readonly Guard[]): Guard {
  return sql<SqlBool>`(${sql.join(conditions, sql` and `)})`;
}

interface SourceRow {
  readonly project_id: string | null;
  readonly ecosystem: Ecosystem;
  readonly type: string;
  readonly status: string;
}

function sourceVisible(ctx: OrgContext, sourceId: string): Guard {
  return sql<SqlBool>`exists (select 1 from source as visible_source
    where visible_source.id = ${sourceId} and visible_source.org_id = ${ctx.orgId}
      and (visible_source.project_id is null or exists (
        select 1 from project as visible_project
        where visible_project.id = visible_source.project_id
          and visible_project.org_id = ${ctx.orgId} and visible_project.status = 'active')))`;
}

function isProxy(type: string): boolean {
  return (PROXY_TYPES as readonly string[]).includes(type);
}

export function createRegisteredNameRepository(executor: SqlExecutor): RegisteredNameRepository {
  function authority(
    ctx: OrgContext,
    fence: MutationFence,
    projectId: string | null,
    providerAnchors: readonly ProtectedHolderProvider[],
  ): Guard {
    const permission = projectId === null ? 'org:sources:write' : 'project:sources:write';
    return actorHolds(ctx, fence, { permission, projectId, providerAnchors });
  }

  async function holds(condition: Guard): Promise<boolean> {
    const [row] = await executor.all<{ held: number }>(probe(condition, false));
    return row?.held === 1;
  }

  async function readSource(ctx: OrgContext, id: string): Promise<SourceRow | null> {
    const [row] = await executor.all<SourceRow>(
      compile(
        db
          .selectFrom('source')
          .select(['project_id', 'ecosystem', 'type', 'status'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      ),
    );
    return row ?? null;
  }

  async function readName(ctx: OrgContext, id: string): Promise<string | null> {
    const [row] = await executor.all<{ source_id: string }>(
      compile(
        db
          .selectFrom('registered_name')
          .select('source_id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      ),
    );
    return row?.source_id ?? null;
  }

  function organizationProxy(ctx: OrgContext, id?: string): Guard {
    return sql<SqlBool>`exists (select 1 from source as claim_proxy
      where claim_proxy.org_id = ${ctx.orgId} and claim_proxy.type = 'npmjs_proxy'
        ${id === undefined ? sql`` : sql`and claim_proxy.id = ${id}`})`;
  }

  return {
    async claimProxy(ctx) {
      const rows = await executor.all<{ id: string }>(
        compile(
          db
            .selectFrom('source')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('type', '=', 'npmjs_proxy')
            .orderBy('id')
            .limit(1),
        ),
      );
      return rows[0]?.id ?? null;
    },
    async list(ctx, input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        throw new RangeError('invalid registered-name page limit');
      let query = db
        .selectFrom('registered_name as names')
        .select(['names.id', 'names.source_id as sourceId', 'names.ecosystem', 'names.pattern'])
        .where('names.org_id', '=', ctx.orgId)
        .where('names.source_id', '=', input.sourceId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('source as owner')
              .select('owner.id')
              .whereRef('owner.id', '=', 'names.source_id')
              .where('owner.org_id', '=', ctx.orgId),
          ),
        );
      if (input.after !== undefined) query = query.where('names.id', '>', input.after);
      const rows = await executor.all<RegisteredNameRecord>(
        compile(query.orderBy('names.id', 'asc').limit(input.limit + 1)),
      );
      const items = rows.slice(0, input.limit);
      return { items, next: rows.length > input.limit ? items.at(-1)!.id : null };
    },
    async get(ctx, id) {
      const [row] = await executor.all<RegisteredNameRecord>(
        compile(
          db
            .selectFrom('registered_name')
            .select(['id', 'source_id as sourceId', 'ecosystem', 'pattern'])
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id),
        ),
      );
      return row ?? null;
    },
    async owner(ctx, id) {
      const [row] = await executor.all<{ sourceId: string; projectId: string | null }>(
        compile(
          db
            .selectFrom('registered_name')
            .innerJoin('source', (join) =>
              join
                .onRef('source.id', '=', 'registered_name.source_id')
                .onRef('source.org_id', '=', 'registered_name.org_id'),
            )
            .select(['source.id as sourceId', 'source.project_id as projectId'])
            .where('registered_name.org_id', '=', ctx.orgId)
            .where('source.org_id', '=', ctx.orgId)
            .where('registered_name.id', '=', id),
        ),
      );
      return row ?? null;
    },

    async add(ctx, fence, input) {
      const held = authority(ctx, fence, null, input.providerAnchors);
      if (!(await holds(held))) return 'forbidden';
      if (
        input.idempotency !== undefined &&
        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))
      )
        return 'conflict';
      const source = await readSource(ctx, input.sourceId);
      if (source === null) return 'not_found';
      if (isProxy(source.type)) return 'proxy_source';
      if (source.type === 'hosted' && source.project_id !== null) return 'conflict';
      if (
        (source.type === 'hosted' || source.type === 'vcs') && source.ecosystem === 'npm'
          ? !isNpmClaim(input.pattern)
          : !isValidPattern(input.pattern) || !isRegistrablePattern(input.pattern, source.ecosystem)
      )
        return 'invalid_pattern';
      if (input.replace && (await readName(ctx, input.id)) !== input.sourceId) return 'not_found';
      if (input.replace && (source.type !== 'hosted' || source.ecosystem !== 'npm'))
        return 'conflict';
      const sameSource = sql<SqlBool>`exists (select 1 from registered_name as existing
        where existing.org_id = ${ctx.orgId}
          and ${input.replace ? sql`existing.id <> ${input.id} and` : sql``} (existing.id = ${input.id}
            or (existing.source_id = ${input.sourceId} and existing.ecosystem = ${source.ecosystem}
              and existing.pattern = ${input.pattern})))`;
      const exactDuplicate = sql<SqlBool>`exists (select 1 from registered_name
        where org_id = ${ctx.orgId} and ecosystem = ${source.ecosystem}
          and source_id <> ${input.sourceId} and pattern = ${input.pattern})`;
      const storedOverlap =
        (source.type !== 'hosted' && source.type !== 'vcs') || source.ecosystem !== 'npm'
          ? sql<SqlBool>`0`
          : sql<SqlBool>`exists (select 1 from package as stored_package
          join source as stored_source on stored_source.id = stored_package.source_id
            and stored_source.org_id = ${ctx.orgId}
          where stored_package.org_id = ${ctx.orgId} and stored_package.ecosystem = 'npm'
            and stored_package.source_id <> ${input.sourceId}
            and stored_source.type not in (${sql.join(PROXY_TYPES)})
            and ${npmClaimCover(sql.lit('npm'), sql`${input.pattern}`, sql.ref('stored_package.name'))})`;
      const otherSource = sql<SqlBool>`exists (select 1 from registered_name as existing
        where existing.org_id = ${ctx.orgId} and existing.ecosystem = ${source.ecosystem}
          and existing.source_id <> ${input.sourceId}
          and (existing.pattern = ${input.pattern}
            ${
              source.ecosystem !== 'npm'
                ? sql``
                : sql`or
              ((${source.type} in ('hosted', 'vcs') or exists (select 1 from source as overlap_participant where overlap_participant.org_id = ${ctx.orgId} and overlap_participant.id = existing.source_id and overlap_participant.type in ('hosted', 'vcs'))) and (
              (${input.pattern.includes('*') ? 1 : 0} = 1
                and substr(existing.pattern, 1, min(case when instr(existing.pattern, '*') > 0 then instr(existing.pattern, '*') - 1 else length(existing.pattern) end, ${input.pattern.split('*')[0]!.length})) = substr(${input.pattern}, 1, min(case when instr(existing.pattern, '*') > 0 then instr(existing.pattern, '*') - 1 else length(existing.pattern) end, ${input.pattern.split('*')[0]!.length})))
              or
              (case when length(existing.pattern) <= ${sql.lit(MAX_PATTERN_BYTES)} then ${input.pattern} glob existing.pattern else 0 end)
              or (substr(existing.pattern, -2) = '/*' and instr(existing.pattern, '*') = length(existing.pattern)
                and substr(${input.pattern}, 1, length(existing.pattern) - 1) = substr(existing.pattern, 1, length(existing.pattern) - 1))
              ${input.pattern.endsWith('/*') ? sql`or substr(existing.pattern, 1, ${input.pattern.length - 1}) = ${input.pattern.slice(0, -1)}` : sql``}))`
            }))`;
      const cachedPublic =
        (source.type !== 'hosted' && source.type !== 'vcs') || source.ecosystem !== 'npm'
          ? sql<SqlBool>`0`
          : sql<SqlBool>`exists (
        select 1 from package as claim_package join source as claim_source
          on claim_source.id = claim_package.source_id and claim_source.org_id = ${ctx.orgId}
        where claim_package.org_id = ${ctx.orgId} and claim_package.ecosystem = 'npm'
          and claim_package.source_id <> ${input.sourceId}
          and claim_source.type in ('npmjs_proxy', 'npm_registry')
          and (claim_package.name = ${input.pattern}
            ${input.pattern.endsWith('/*') ? sql`or substr(claim_package.name, 1, ${input.pattern.length - 1}) = ${input.pattern.slice(0, -1)}` : sql``}))`;
      const verified =
        (source.type !== 'hosted' && source.type !== 'vcs') ||
        source.ecosystem !== 'npm' ||
        input.pattern.includes('*')
          ? sql<SqlBool>`1`
          : input.claimProbe === undefined
            ? sql<SqlBool>`not ${organizationProxy(ctx)}`
            : organizationProxy(ctx, input.claimProbe.proxyId);
      const retainsPackages = input.replace
        ? sql<SqlBool>`not exists (
        select 1 from package as owned_package join registered_name as old_claim
          on old_claim.org_id = ${ctx.orgId} and old_claim.id = ${input.id} and old_claim.source_id = ${input.sourceId}
        where owned_package.org_id = ${ctx.orgId} and owned_package.source_id = ${input.sourceId}
          and ${npmClaimCover(sql.lit('npm'), sql.ref('old_claim.pattern'), sql.ref('owned_package.name'))}
          and not ${npmClaimCover(sql.lit('npm'), sql`${input.pattern}`, sql.ref('owned_package.name'))}
      )`
        : sql<SqlBool>`1`;
      const sourceUnchanged = sql<SqlBool>`exists (select 1 from source as owner
        where owner.id = ${input.sourceId} and owner.org_id = ${ctx.orgId}
          and owner.ecosystem = ${source.ecosystem}
          and owner.type = ${source.type}
          and (owner.type <> 'hosted' or owner.project_id is null))`;
      const visible = sourceVisible(ctx, input.sourceId);
      const insert = input.replace
        ? compile(
            db
              .updateTable('registered_name')
              .set({ pattern: input.pattern })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', input.id)
              .where('source_id', '=', input.sourceId),
          )
        : compile(
            db.insertInto('registered_name').values({
              id: input.id,
              org_id: ctx.orgId,
              source_id: input.sourceId,
              ecosystem: source.ecosystem,
              pattern: input.pattern,
            }),
          );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allOf([held, sourceUnchanged]), ctx),
        [
          ...assertCheck(visible),
          ...assertCheck(sql<SqlBool>`not ${otherSource}`),
          ...assertCheck(sql<SqlBool>`not ${storedOverlap}`),
          ...assertCheck(sql<SqlBool>`not ${cachedPublic}`),
          ...assertCheck(verified),
          ...assertCheck(retainsPackages),
          ...(input.previousPattern === undefined
            ? []
            : assertCheck(
                sql<SqlBool>`exists (select 1 from registered_name where org_id = ${ctx.orgId} and id = ${input.id} and source_id = ${input.sourceId} and pattern = ${input.previousPattern})`,
              )),
          ...(input.replace
            ? assertCheck(
                sql<SqlBool>`exists (select 1 from registered_name where org_id = ${ctx.orgId} and id = ${input.id} and source_id = ${input.sourceId})`,
              )
            : []),
          insert,
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        {
          authority: probe(held, true),
          conflict: probe(
            sql<SqlBool>`(${liveIdempotencyCollision(ctx, input.idempotency)} or ${otherSource})`,
            false,
          ),
          collision: probe(sameSource, false),
        },
      );
      if (outcome.ok) return 'added';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      if (!(await holds(visible))) return 'not_found';
      if (outcome.reason === 'authority') return 'forbidden';
      if (
        outcome.reason === 'conflict' &&
        input.idempotency !== undefined &&
        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))
      )
        return 'conflict';
      if (await holds(exactDuplicate)) return 'pattern_taken';
      if ((await holds(otherSource)) || (await holds(storedOverlap))) return 'claim_overlap';
      if (!(await holds(retainsPackages))) return 'claim_in_use';
      if (await holds(cachedPublic)) return 'name_public';
      if (!(await holds(verified))) return 'name_public_unverified';
      if (outcome.reason === 'conflict') return 'pattern_taken';
      if (outcome.reason === 'collision') return 'duplicate';
      return (await readSource(ctx, input.sourceId)) === null ? 'not_found' : 'conflict';
    },

    async remove(ctx, fence, input) {
      const held = authority(ctx, fence, null, input.providerAnchors);
      if (!(await holds(held))) return 'forbidden';
      if (
        input.idempotency !== undefined &&
        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))
      )
        return 'conflict';
      const sourceId = await readName(ctx, input.id);
      if (sourceId === null) return 'not_found';
      if (input.pauseAudit.target.type !== 'source' || input.pauseAudit.target.id !== sourceId)
        return 'conflict';
      const owned = sql<SqlBool>`exists (select 1 from registered_name as target
        where target.id = ${input.id} and target.org_id = ${ctx.orgId}
          and target.source_id = ${sourceId})`;
      const visible = sourceVisible(ctx, sourceId);
      const pause = compile(
        db
          .updateTable('source')
          .set({ status: 'paused', updated_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
          .where('id', '=', sourceId)
          .where('org_id', '=', ctx.orgId)
          .where('status', '<>', 'paused')
          .where(sql<SqlBool>`not ${sourceActivatable(ctx, sourceId)}`),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allOf([held, owned]), ctx),
        [
          ...assertCheck(visible),
          compile(
            db
              .deleteFrom('registered_name')
              .where('id', '=', input.id)
              .where('org_id', '=', ctx.orgId),
          ),
          pause,
          auditPendingStatement(ctx, input.pauseAudit, { sql: 'changes() = 1', params: [] }),
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        {
          authority: probe(held, true),
          conflict: probe(liveIdempotencyCollision(ctx, input.idempotency), false),
        },
      );
      if (outcome.ok) {
        return outcome.results[outcome.results.length - (input.idempotency === undefined ? 3 : 4)]
          ?.changes === 1
          ? 'removed_and_paused'
          : 'removed';
      }
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      if (!(await holds(visible))) return 'not_found';
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') return 'conflict';
      return (await readName(ctx, input.id)) === null ? 'not_found' : 'conflict';
    },

    async enable(ctx, fence, input) {
      const source = await readSource(ctx, input.id);
      const held = authority(ctx, fence, source?.project_id ?? null, input.providerAnchors);
      if (!(await holds(held))) return 'forbidden';
      if (
        input.idempotency !== undefined &&
        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))
      )
        return 'conflict';
      if (source === null) return 'not_found';
      if (source.status !== 'paused') return 'already_enabled';
      const owned = sql<SqlBool>`exists (select 1 from source as target
        where target.id = ${input.id} and target.org_id = ${ctx.orgId}
          and target.project_id is ${source.project_id})`;
      const activatable = sourceActivatable(ctx, input.id);
      const paused = sql<SqlBool>`exists (select 1 from source as target
        where target.id = ${input.id} and target.org_id = ${ctx.orgId} and target.status = 'paused')`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allOf([held, owned]), ctx),
        [
          ...assertCheck(paused),
          ...assertCheck(activatable),
          compile(
            db
              .updateTable('source')
              .set({
                status: 'active',
                next_poll_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
                updated_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
              })
              .where('id', '=', input.id)
              .where('org_id', '=', ctx.orgId)
              .where('status', '=', 'paused'),
          ),
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        {
          authority: probe(held, true),
          conflict: probe(
            sql<SqlBool>`(${liveIdempotencyCollision(ctx, input.idempotency)} or ${allOf([owned, paused, sql<SqlBool>`not ${activatable}`])})`,
            false,
          ),
          collision: probe(allOf([owned, sql<SqlBool>`not ${paused}`]), false),
        },
      );
      if (outcome.ok) return 'enabled';
      if (outcome.reason === 'authority') return 'forbidden';
      if (
        outcome.reason === 'conflict' &&
        input.idempotency !== undefined &&
        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))
      )
        return 'conflict';
      if (outcome.reason === 'conflict') return 'activation_requires_registered_names';
      if (outcome.reason === 'collision') return 'already_enabled';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      const after = await readSource(ctx, input.id);
      return after === null || after.project_id !== source.project_id ? 'not_found' : 'conflict';
    },
  };
}
