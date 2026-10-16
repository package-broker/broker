import { sql, type Expression, type SqlBool } from 'kysely';
import type { MutationFence } from '@package-broker/core/authz/fence';
import { MAX_KEY_LENGTH } from '@package-broker/core/catalogue/names';
import { MAX_PATTERN_WILDCARDS, isValidPattern } from '@package-broker/core/catalogue/patterns';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
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

const PROXY_TYPES = ['packagist_proxy', 'npmjs_proxy'] as const;
const COMPOSER_PATTERN = /^[a-z0-9._*-]+\/[a-z0-9._*-]+$/;
const NPM_UNSCOPED_PATTERN = /^[a-z0-9._~!*-]+$/;
const NPM_SCOPED_PATTERN = /^@[a-z0-9._~!*-]+\/[a-z0-9._~!*-]+$/;

type SourceRef = string | Expression<string>;
type Ecosystem = 'composer' | 'npm';

export interface NewRegisteredName {
  readonly id: string;
  readonly sourceId: string;
  readonly pattern: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface RegisteredNameTarget {
  readonly id: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

/**
 * Every registered-name write needs `org:sources:write`, also for project-level sources, and
 * `forbidden` is answered before existence is revealed. `pattern_taken`: another source of the
 * organization holds the pattern; the answer names neither that source nor its project.
 * `indeterminate`: the response was lost and the write may have committed; re-read.
 */
export interface RegisteredNameRepository {
  add(
    ctx: OrgContext,
    fence: MutationFence,
    input: NewRegisteredName,
  ): Promise<
    | 'added'
    | 'invalid_pattern'
    | 'proxy_source'
    | 'pattern_taken'
    | 'duplicate'
    | 'not_found'
    | 'forbidden'
    | 'conflict'
    | 'indeterminate'
  >;
  /** An active non-proxy source left without coverage is paused in the same batch. */
  remove(
    ctx: OrgContext,
    fence: MutationFence,
    input: RegisteredNameTarget,
  ): Promise<
    'removed' | 'removed_and_paused' | 'not_found' | 'forbidden' | 'conflict' | 'indeterminate'
  >;
  /**
   * The only path that activates a paused non-proxy source. Authority is the source owner's:
   * `org:sources:write` for an organization source, `project:sources:write` for a project source.
   * `already_enabled`: the source is not paused; nothing is written.
   */
  enable(
    ctx: OrgContext,
    fence: MutationFence,
    input: RegisteredNameTarget,
  ): Promise<
    | 'enabled'
    | 'already_enabled'
    | 'activation_requires_registered_names'
    | 'not_found'
    | 'forbidden'
    | 'conflict'
    | 'indeterminate'
  >;
}

export function isRegistrablePattern(pattern: string, ecosystem: Ecosystem): boolean {
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

/** A row outside the T305 grammar (alphabet, length, wildcard count) never covers a key. */
export function coveredByRegisteredNames(
  ctx: OrgContext,
  sourceId: SourceRef,
  key: string | Expression<string>,
): Guard {
  return sql<SqlBool>`exists (select 1 from registered_name as rn_cov
    where rn_cov.org_id = ${ctx.orgId} and rn_cov.source_id = ${sourceId}
      and rn_cov.pattern not glob '*[^a-z0-9._~@!/*-]*'
      and length(cast(rn_cov.pattern as blob)) = length(rn_cov.pattern)
      and length(rn_cov.pattern) between 1 and ${sql.lit(MAX_KEY_LENGTH)}
      and length(rn_cov.pattern) - length(replace(rn_cov.pattern, '*', ''))
        <= ${sql.lit(MAX_PATTERN_WILDCARDS)}
      and ${key} glob rn_cov.pattern)`;
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

  return {
    async add(ctx, fence, input) {
      const held = authority(ctx, fence, null, input.providerAnchors);
      if (!(await holds(held))) return 'forbidden';
      const source = await readSource(ctx, input.sourceId);
      if (source === null) return 'not_found';
      if (isProxy(source.type)) return 'proxy_source';
      if (!isRegistrablePattern(input.pattern, source.ecosystem)) return 'invalid_pattern';
      const sameSource = sql<SqlBool>`exists (select 1 from registered_name as existing
        where existing.org_id = ${ctx.orgId}
          and (existing.id = ${input.id}
            or (existing.source_id = ${input.sourceId} and existing.ecosystem = ${source.ecosystem}
              and existing.pattern = ${input.pattern})))`;
      const otherSource = sql<SqlBool>`exists (select 1 from registered_name as existing
        where existing.org_id = ${ctx.orgId} and existing.ecosystem = ${source.ecosystem}
          and existing.pattern = ${input.pattern} and existing.source_id <> ${input.sourceId})`;
      const sourceUnchanged = sql<SqlBool>`exists (select 1 from source as owner
        where owner.id = ${input.sourceId} and owner.org_id = ${ctx.orgId}
          and owner.ecosystem = ${source.ecosystem}
          and owner.type not in (${sql.join(PROXY_TYPES)}))`;
      const insert = compile(
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
        [insert],
        {
          authority: probe(held, true),
          conflict: probe(otherSource, false),
          collision: probe(sameSource, false),
        },
      );
      if (outcome.ok) return 'added';
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') return 'pattern_taken';
      if (outcome.reason === 'collision') return 'duplicate';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      return (await readSource(ctx, input.sourceId)) === null ? 'not_found' : 'conflict';
    },

    async remove(ctx, fence, input) {
      const held = authority(ctx, fence, null, input.providerAnchors);
      if (!(await holds(held))) return 'forbidden';
      const sourceId = await readName(ctx, input.id);
      if (sourceId === null) return 'not_found';
      const owned = sql<SqlBool>`exists (select 1 from registered_name as target
        where target.id = ${input.id} and target.org_id = ${ctx.orgId}
          and target.source_id = ${sourceId})`;
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
          compile(
            db
              .deleteFrom('registered_name')
              .where('id', '=', input.id)
              .where('org_id', '=', ctx.orgId),
          ),
          pause,
        ],
        { authority: probe(held, true) },
      );
      if (outcome.ok) {
        return outcome.results[outcome.results.length - 1]?.changes === 1
          ? 'removed_and_paused'
          : 'removed';
      }
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      return (await readName(ctx, input.id)) === null ? 'not_found' : 'conflict';
    },

    async enable(ctx, fence, input) {
      const source = await readSource(ctx, input.id);
      if (source === null) {
        return (await holds(authority(ctx, fence, null, input.providerAnchors)))
          ? 'not_found'
          : 'forbidden';
      }
      const held = authority(ctx, fence, source.project_id, input.providerAnchors);
      if (!(await holds(held))) return 'forbidden';
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
                updated_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
              })
              .where('id', '=', input.id)
              .where('org_id', '=', ctx.orgId)
              .where('status', '=', 'paused'),
          ),
        ],
        {
          authority: probe(held, true),
          conflict: probe(allOf([owned, paused, sql<SqlBool>`not ${activatable}`]), false),
          collision: probe(allOf([owned, sql<SqlBool>`not ${paused}`]), false),
        },
      );
      if (outcome.ok) return 'enabled';
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') return 'activation_requires_registered_names';
      if (outcome.reason === 'collision') return 'already_enabled';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      const after = await readSource(ctx, input.id);
      return after === null || after.project_id !== source.project_id ? 'not_found' : 'conflict';
    },
  };
}
