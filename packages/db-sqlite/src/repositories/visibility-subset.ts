import { sql, type SqlBool } from 'kysely';
import type { VisibilityAudit } from '@package-broker/core/db/catalogue';
import { visibilityAuditStatements } from './visibility-audit.js';
import type { FailureProbes, MutationFence } from '@package-broker/core/authz/fence';
import { isValidPattern, MAX_PATTERNS_PER_RULE } from '@package-broker/core/catalogue/patterns';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  newOpId,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { rederiveStatements } from './visibility-derive.js';

// D1 caps a LIKE or GLOB pattern at 50 bytes; a longer stored pattern would fail every derivation that globs it.
const MAX_GLOB_PATTERN_BYTES = 50;
const GUARD_STATEMENTS = 3;

export type PatternEffect = 'include' | 'exclude';
export type SubsetFailure = 'forbidden' | 'indeterminate' | 'failed';

export interface PatternInput extends VisibilityAudit {
  readonly projectId: string;
  readonly sourceId: string;
  readonly pattern: string;
  readonly effect: PatternEffect;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface PatternTarget extends VisibilityAudit {
  readonly projectId: string;
  readonly sourceId: string;
  readonly pattern: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface ExplicitTarget {
  readonly projectId: string;
  readonly packageId: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export type AddPatternResult =
  | 'added'
  | 'unchanged'
  | 'invalid_pattern'
  | 'too_many_patterns'
  | 'not_attached'
  | 'conflict'
  | SubsetFailure;
export type RemovePatternResult = 'removed' | 'not_found' | SubsetFailure;
export type AddExplicitResult = 'added' | 'unchanged' | 'not_eligible' | SubsetFailure;
export type RemoveExplicitResult = 'removed' | 'not_found' | SubsetFailure;

export interface VisibilitySubsetRepository {
  addPattern(ctx: OrgContext, fence: MutationFence, input: PatternInput): Promise<AddPatternResult>;
  removePattern(
    ctx: OrgContext,
    fence: MutationFence,
    input: PatternTarget,
  ): Promise<RemovePatternResult>;
  addExplicit(
    ctx: OrgContext,
    fence: MutationFence,
    input: ExplicitTarget,
  ): Promise<AddExplicitResult>;
  removeExplicit(
    ctx: OrgContext,
    fence: MutationFence,
    input: ExplicitTarget,
  ): Promise<RemoveExplicitResult>;
}

function storablePattern(pattern: string): boolean {
  return (
    isValidPattern(pattern) && new TextEncoder().encode(pattern).length <= MAX_GLOB_PATTERN_BYTES
  );
}

function probe(condition: Guard): Statement {
  return compile(db.selectNoFrom(sql<number>`(${condition}) is not 1`.as('failed')));
}

function manages(
  ctx: OrgContext,
  fence: MutationFence,
  projectId: string,
  providerAnchors: readonly ProtectedHolderProvider[],
  allowArchived: boolean,
): Guard {
  return actorHolds(ctx, fence, {
    permission: 'project:packages:manage',
    projectId,
    providerAnchors,
    allowArchived,
  });
}

function sourceServes(ctx: OrgContext, projectId: string, sourceId: string): Guard {
  return sql<SqlBool>`exists (
    select 1 from project_source as vs_attachment
    join source as vs_source on vs_source.id = vs_attachment.source_id
    join project as vs_project on vs_project.id = vs_attachment.project_id
    where vs_attachment.project_id = ${projectId}
      and vs_attachment.source_id = ${sourceId}
      and vs_attachment.org_id = ${ctx.orgId}
      and vs_source.org_id = ${ctx.orgId}
      and vs_project.org_id = ${ctx.orgId}
      and (vs_source.project_id is null or vs_source.project_id = vs_attachment.project_id)
  )`;
}

function packageServes(ctx: OrgContext, projectId: string, packageId: string): Guard {
  return sql<SqlBool>`exists (
    select 1 from package as vs_package
    join project_source as vs_attachment on vs_attachment.source_id = vs_package.source_id
    join source as vs_source on vs_source.id = vs_package.source_id
    join project as vs_project on vs_project.id = vs_attachment.project_id
    where vs_package.id = ${packageId}
      and vs_package.org_id = ${ctx.orgId}
      and vs_attachment.project_id = ${projectId}
      and vs_attachment.org_id = ${ctx.orgId}
      and vs_source.org_id = ${ctx.orgId}
      and vs_project.org_id = ${ctx.orgId}
      and vs_source.ecosystem = vs_package.ecosystem
      and (vs_source.project_id is null or vs_source.project_id = vs_attachment.project_id)
  )`;
}

function projectActive(ctx: OrgContext, projectId: string): Guard {
  return sql<SqlBool>`exists (
    select 1 from project as vs_active
    where vs_active.id = ${projectId} and vs_active.org_id = ${ctx.orgId} and vs_active.status = 'active'
  )`;
}

function hiddenPackage(
  ctx: OrgContext,
  packageId: string,
  owner: { readonly projectId: string } | null,
): Guard {
  const ownedBy =
    owner === null
      ? sql`vs_owner.project_id is null`
      : sql`vs_owner.project_id = ${owner.projectId}`;
  return sql<SqlBool>`exists (
    select 1 from package as vs_hidden
    join source as vs_owner on vs_owner.id = vs_hidden.source_id
    where vs_hidden.id = ${packageId}
      and vs_hidden.org_id = ${ctx.orgId}
      and vs_owner.org_id = ${ctx.orgId}
      and vs_hidden.visible_to_new_projects = 0
      and ${ownedBy}
  )`;
}

function patternRow(
  ctx: OrgContext,
  target: { readonly projectId: string; readonly sourceId: string },
  extra: ReturnType<typeof sql>,
): Guard {
  return sql<SqlBool>`exists (
    select 1 from project_package_pattern as vs_pattern
    where vs_pattern.org_id = ${ctx.orgId}
      and vs_pattern.project_id = ${target.projectId}
      and vs_pattern.source_id = ${target.sourceId}
      and ${extra}
  )`;
}

function changesAt(results: readonly { readonly changes: number }[], index: number): number {
  return results[GUARD_STATEMENTS + index]?.changes ?? 0;
}

function failure(reason: string): SubsetFailure | null {
  if (reason === 'indeterminate') return 'indeterminate';
  if (reason === 'authority') return 'forbidden';
  return null;
}

export function createVisibilitySubsetRepository(
  executor: SqlExecutor,
): VisibilitySubsetRepository {
  async function patternCount(
    ctx: OrgContext,
    input: PatternInput,
  ): Promise<{ readonly sameEffect: number; readonly present: boolean }> {
    const [row] = await executor.all<{ same: number; present: number }>(
      compile(
        db
          .selectFrom('project_package_pattern')
          .select([
            sql<number>`count(case when effect = ${input.effect} then 1 end)`.as('same'),
            sql<number>`count(case when pattern = ${input.pattern} then 1 end)`.as('present'),
          ])
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', input.projectId)
          .where('source_id', '=', input.sourceId),
      ),
    );
    return { sameEffect: row?.same ?? 0, present: (row?.present ?? 0) > 0 };
  }

  async function refusedBy(statement: Statement): Promise<boolean> {
    const [row] = await executor.all<{ failed: number }>(statement);
    return row?.failed !== 0;
  }

  async function packageSource(ctx: OrgContext, packageId: string): Promise<string | null> {
    const [row] = await executor.all<{ source_id: string }>(
      compile(
        db
          .selectFrom('package')
          .select('source_id')
          .where('id', '=', packageId)
          .where('org_id', '=', ctx.orgId),
      ),
    );
    return row?.source_id ?? null;
  }

  return {
    async addPattern(ctx, fence, input) {
      if (!storablePattern(input.pattern)) return 'invalid_pattern';
      const before = await patternCount(ctx, input);
      if (!before.present && before.sameEffect >= MAX_PATTERNS_PER_RULE) {
        return 'too_many_patterns';
      }
      const held = manages(
        ctx,
        fence,
        input.projectId,
        input.providerAnchors,
        input.effect === 'exclude',
      );
      const attached = sourceServes(ctx, input.projectId, input.sourceId);
      const clash = patternRow(
        ctx,
        input,
        sql`vs_pattern.pattern = ${input.pattern} and vs_pattern.effect <> ${input.effect}`,
      );
      const insert = compile(
        db
          .insertInto('project_package_pattern')
          .values({
            id: newOpId(),
            org_id: ctx.orgId,
            project_id: input.projectId,
            source_id: input.sourceId,
            pattern: input.pattern,
            effect: input.effect,
          })
          .onConflict((conflict) =>
            conflict.columns(['project_id', 'source_id', 'pattern']).doNothing(),
          ),
      );
      const withinLimit = sql<SqlBool>`(
        select count(*) from project_package_pattern as vs_limit
        where vs_limit.org_id = ${ctx.orgId}
          and vs_limit.project_id = ${input.projectId}
          and vs_limit.source_id = ${input.sourceId}
          and vs_limit.effect = ${input.effect}
      ) <= ${sql.lit(MAX_PATTERNS_PER_RULE)}`;
      const probes: FailureProbes = {
        authority: probe(held),
        conflict: probe(attached),
        collision: probe(sql<SqlBool>`not ${clash}`),
      };
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(
          held,
          ctx,
          sql<SqlBool>`not ${patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern}`)}`,
        ),
        [
          ...assertCheck(attached),
          ...assertCheck(sql<SqlBool>`not ${clash}`),
          insert,
          ...visibilityAuditStatements(ctx, input),
          ...assertCheck(withinLimit),
          ...rederiveStatements(ctx, {
            kind: 'projectSource',
            projectId: input.projectId,
            sourceId: input.sourceId,
          }),
        ],
        probes,
      );
      if (outcome.ok) return changesAt(outcome.results, 2) > 0 ? 'added' : 'unchanged';
      const refused = failure(outcome.reason);
      if (refused !== null) return refused;
      if (outcome.reason === 'conflict') return 'not_attached';
      if (outcome.reason === 'collision') return 'conflict';
      const after = await patternCount(ctx, input);
      return !after.present && after.sameEffect >= MAX_PATTERNS_PER_RULE
        ? 'too_many_patterns'
        : 'failed';
    },

    async removePattern(ctx, fence, input) {
      const held = manages(ctx, fence, input.projectId, input.providerAnchors, true);
      const narrowing = sql<SqlBool>`(
        ${projectActive(ctx, input.projectId)}
        or (
          not ${patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern} and vs_pattern.effect = 'exclude'`)}
          and (
            not ${patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern}`)}
            or ${patternRow(ctx, input, sql`vs_pattern.pattern <> ${input.pattern} and vs_pattern.effect = 'include'`)}
          )
        )
      )`;
      const remove = compile(
        db
          .deleteFrom('project_package_pattern')
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', input.projectId)
          .where('source_id', '=', input.sourceId)
          .where('pattern', '=', input.pattern),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(held, ctx, patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern}`)),
        [
          ...assertCheck(narrowing),
          remove,
          ...visibilityAuditStatements(ctx, input, true),
          ...rederiveStatements(ctx, {
            kind: 'projectSource',
            projectId: input.projectId,
            sourceId: input.sourceId,
          }),
        ],
        { authority: probe(sql<SqlBool>`(${held} and ${narrowing})`) },
      );
      if (outcome.ok) return changesAt(outcome.results, 1) > 0 ? 'removed' : 'not_found';
      return failure(outcome.reason) ?? 'failed';
    },

    async addExplicit(ctx, fence, input) {
      const manageHeld = manages(ctx, fence, input.projectId, input.providerAnchors, false);
      const orgHeld = actorHolds(ctx, fence, {
        permission: 'org:sources:write',
        projectId: null,
        providerAnchors: input.providerAnchors,
      });
      const ownHeld = actorHolds(ctx, fence, {
        permission: 'project:sources:write',
        projectId: input.projectId,
        providerAnchors: input.providerAnchors,
      });
      const active = projectActive(ctx, input.projectId);
      const allowed = sql<SqlBool>`(${active} and (${manageHeld} or ${orgHeld} or ${ownHeld}))`;
      if ((await packageSource(ctx, input.packageId)) === null) {
        return (await refusedBy(probe(allowed))) ? 'forbidden' : 'not_eligible';
      }
      const eligible = packageServes(ctx, input.projectId, input.packageId);
      const flagOne = sql<SqlBool>`exists (
        select 1 from package as vs_flag
        where vs_flag.id = ${input.packageId} and vs_flag.org_id = ${ctx.orgId}
          and vs_flag.visible_to_new_projects = 1
      )`;
      const orgHidden = hiddenPackage(ctx, input.packageId, null);
      const ownHidden = hiddenPackage(ctx, input.packageId, { projectId: input.projectId });
      const checks = [
        sql<SqlBool>`(not ${flagOne} or ${manageHeld})`,
        sql<SqlBool>`(not ${orgHidden} or ${orgHeld})`,
        sql<SqlBool>`(not ${ownHidden} or ${ownHeld})`,
      ];
      const authorized = sql<SqlBool>`(${active} and (
        (${flagOne} and ${manageHeld})
        or (${orgHidden} and ${orgHeld})
        or (${ownHidden} and ${ownHeld})
      ))`;
      const upsert = compile(
        db
          .insertInto('project_package')
          .columns(['org_id', 'project_id', 'package_id', 'origin'])
          .expression(
            db
              .selectFrom('package')
              .select([
                'org_id',
                sql<string>`${input.projectId}`.as('project_id'),
                'id',
                sql<'explicit'>`'explicit'`.as('origin'),
              ])
              .where('id', '=', input.packageId)
              .where('org_id', '=', ctx.orgId),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['project_id', 'package_id'])
              .doUpdateSet({ origin: 'explicit' })
              .where('project_package.origin', '<>', 'explicit'),
          ),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [...assertCheck(eligible), ...checks.flatMap((check) => assertCheck(check)), upsert],
        {
          authority: probe(authorized),
          conflict: probe(eligible),
        },
      );
      if (outcome.ok) return changesAt(outcome.results, 4) > 0 ? 'added' : 'unchanged';
      const refused = failure(outcome.reason);
      if (refused !== null) return refused;
      return outcome.reason === 'conflict' ? 'not_eligible' : 'failed';
    },

    async removeExplicit(ctx, fence, input) {
      const held = manages(ctx, fence, input.projectId, input.providerAnchors, true);
      const sourceId = await packageSource(ctx, input.packageId);
      if (sourceId === null) return (await refusedBy(probe(held))) ? 'forbidden' : 'not_found';
      const remove = compile(
        db
          .deleteFrom('project_package')
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', input.projectId)
          .where('package_id', '=', input.packageId)
          .where('origin', '=', 'explicit'),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(held, ctx),
        [
          remove,
          ...rederiveStatements(ctx, {
            kind: 'projectSource',
            projectId: input.projectId,
            sourceId,
          }),
        ],
        { authority: probe(held) },
      );
      if (outcome.ok) return changesAt(outcome.results, 0) > 0 ? 'removed' : 'not_found';
      return failure(outcome.reason) ?? 'failed';
    },
  };
}
