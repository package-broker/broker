import {
  D1_STATEMENTS_PER_BATCH,
  D1_STATEMENTS_PER_INVOCATION,
} from '@package-broker/core/db/port';
import { sql } from 'kysely';
import {
  CATALOGUE_SYNC_VERSIONS_PER_CALL,
  type CatalogueWriter,
  type SyncPackageInput,
  type VisibilityStore,
  type VisibilityWriteResult,
} from '@package-broker/core/db/catalogue';
import type { MutationFence } from '@package-broker/core/authz/fence';
import { versionTransition } from '@package-broker/core/catalogue/version-rules';
import type {
  OrgContext,
  SqlExecutor,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';
import {
  assertGuard,
  assertCheck,
  compile,
  db,
  newOpId,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { versionStatusStatements } from '../internal/catalogue-status-statements.js';
import { packageUpsertStatements } from './catalogue-write-package.js';
import { versionInsertStatements } from './catalogue-write-version-insert.js';
import { versionUpdateStatements } from './catalogue-write-version-update.js';
import { distTagStatementGroups, MAX_TAGS_PER_CALL } from './catalogue-write-tags.js';
import { distAttachStatements } from './catalogue-write-dist.js';
import { quarantineStatements } from './catalogue-status.js';
import type { FinalizeGuardOptions } from '@package-broker/core/ingest/finalize-guard';
import { createCatalogueReconciler } from './catalogue-reconcile.js';
import { createVisibilityAttachRepository } from './visibility-attach.js';
import {
  createVisibilitySubsetRepository,
  type AddPatternResult,
  type RemovePatternResult,
  type AddExplicitResult,
  type RemoveExplicitResult,
} from './visibility-subset.js';
import { actorHolds } from './actor-authority.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';
import { blobLeaseNotLive } from './blob-lease-guard.js';

const MAX_STATEMENTS = D1_STATEMENTS_PER_INVOCATION;
const MAX_BATCH_STATEMENTS = D1_STATEMENTS_PER_BATCH;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
function parameterBytes(statements: readonly Statement[]): number {
  return statements.reduce(
    (sum, s) =>
      sum +
      s.params.reduce<number>(
        (n, p) =>
          n +
          (typeof p === 'string'
            ? encoder.encode(p).length
            : p instanceof Uint8Array
              ? p.byteLength
              : p === null
                ? 0
                : 8),
        0,
      ),
    0,
  );
}
function checkBatch(statements: readonly Statement[]): void {
  if (statements.some((s) => s.params.length > 100)) {
    throw new RangeError('statement exceeds 100 parameters');
  }
  if (statements.length > MAX_BATCH_STATEMENTS || parameterBytes(statements) > MAX_BATCH_BYTES)
    throw new RangeError('catalogue batch budget exceeded');
}
function batchExecutor(executor: SqlExecutor): SqlExecutor {
  return {
    driver: executor.driver,
    async all<R>(statement: Statement): Promise<R[]> {
      checkBatch([statement]);
      const results = await executor.batch([statement]);
      return results[0]!.rows as R[];
    },
    async batch(statements) {
      checkBatch(statements);
      return executor.batch(statements);
    },
  };
}

/** Resolve the upsert winner inside each statement, including a concurrent creator's row. */
function bindPackage(statement: Statement, placeholder: string, lookup: Statement): Statement {
  let index = 0;
  const params: Statement['params'][number][] = [];
  const text = statement.sql.replace(/\?/g, () => {
    const value = statement.params[index++];
    if (value === placeholder) {
      params.push(...lookup.params);
      return `(${lookup.sql})`;
    }
    if (value === undefined) throw new TypeError('missing catalogue statement parameter');
    params.push(value);
    return '?';
  });
  return { sql: text, params };
}

function packageLookup(
  ctx: OrgContext,
  input: Pick<SyncPackageInput, 'sourceId' | 'ecosystem' | 'key'>,
): Statement {
  return compile(
    db
      .selectFrom('package')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('source_id', '=', input.sourceId)
      .where('ecosystem', '=', input.ecosystem)
      .where('name', '=', input.key),
  );
}

export function createCatalogueWriter(
  executor: SqlExecutor,
  options: FinalizeGuardOptions = {},
): CatalogueWriter {
  const bounded = batchExecutor(executor);
  const reconcile = createCatalogueReconciler(bounded, { ...options, countUnseen: true });
  return {
    ...reconcile,
    async publishVersion() {
      throw new Error('not_implemented');
    },
    statementBudget: {
      publishVersion: 40,
      syncPackage: D1_STATEMENTS_PER_INVOCATION,
      attachDist: 4,
      openListing: 3,
      markListing: 5,
      finalizeListing: 13,
      quarantine: 5,
      markPackageAbsent: 8,
    },
    syncPayloadLimit: MAX_BATCH_BYTES,
    syncPayloadBytes(ctx, guard, input) {
      const lookup = packageLookup(ctx, input);
      const placeholder = newOpId();
      const request = {
        packageId: placeholder,
        ecosystem: input.ecosystem,
        versions: [input.version],
      };
      const bound = (statements: readonly Statement[]) =>
        parameterBytes(statements.map((s) => bindPackage(s, placeholder, lookup)));
      const group = (build: () => { readonly statements: readonly Statement[] }): number => {
        try {
          return bound(build().statements);
        } catch (error) {
          if (
            error instanceof RangeError &&
            (error as { code?: unknown }).code === 'batch_too_large'
          ) {
            return Number.POSITIVE_INFINITY;
          }
          throw error;
        }
      };
      // syncPackage binds every accepted version into both the update and the insert group.
      return Math.max(
        group(() => versionUpdateStatements(ctx, guard, request)),
        group(() => versionInsertStatements(ctx, guard, request)),
      );
    },
    syncPackageCost({ versions, tags, guardStatements: guard }) {
      if (
        !Number.isSafeInteger(versions) ||
        versions < 0 ||
        versions > CATALOGUE_SYNC_VERSIONS_PER_CALL ||
        !Number.isSafeInteger(tags) ||
        tags < 0 ||
        tags > MAX_TAGS_PER_CALL ||
        !Number.isSafeInteger(guard) ||
        guard < 1
      )
        throw new RangeError('invalid catalogue sync cost shape');

      // Match the writer's indivisible groups. Composer has the larger update term.
      // Include an explicit empty tag map when tags is zero: it still removes old tags.
      const groups = [
        guard + 6, // package guard, source check, create, describe, three derivations
        1, // tombstone probe
        ...(versions === 0 ? [] : [guard + 2 + 3 * versions, guard + 3 + versions]),
        1, // package lookup
      ];
      // The 200-statement split and the 4 MiB split can cut at any group boundary.
      // Reserve a guard at every boundary and a clock for every tag-writing group;
      // this also bounds payload-driven splits that statement counts alone cannot predict.
      const tagHeadAndProbes = guard + 1 + tags;
      const tagWrites = tags + 1;
      const groupCount = groups.length + tagHeadAndProbes + tagWrites + 1;
      const statements =
        groups.reduce((sum, size) => sum + size, 0) +
        tagHeadAndProbes +
        2 * tagWrites +
        1 +
        (groupCount - 1) * guard +
        tagWrites;
      // Calls above the hard cap are rejected before execution.
      return Math.min(MAX_STATEMENTS, statements);
    },
    async syncPackage(ctx, guard, input) {
      if (input.versions.length > CATALOGUE_SYNC_VERSIONS_PER_CALL)
        throw new RangeError('catalogue call exceeds 50 versions');
      if (Object.keys(input.tags ?? {}).length > MAX_TAGS_PER_CALL)
        throw new RangeError('catalogue call exceeds 100 tags');
      const upsert = packageUpsertStatements(ctx, guard, input);
      const lookup = packageLookup(ctx, input);
      const placeholder = newOpId();
      const refusals = new Map<number, 'invalid' | 'too_large' | 'tombstoned'>();
      const seen = new Set<string>();
      const accepted = input.versions.filter((v, index) => {
        const request = {
          packageId: placeholder,
          ecosystem: input.ecosystem,
          versions: [v],
        };
        const reason = seen.has(v.versionNormalized)
          ? 'invalid'
          : (versionInsertStatements(ctx, guard, request).refused[0]?.reason ??
            versionUpdateStatements(ctx, guard, request).refused[0]?.reason);
        seen.add(v.versionNormalized);
        if (reason !== undefined) {
          refusals.set(index, reason);
          return false;
        }
        return true;
      });
      const insert =
        accepted.length === 0
          ? null
          : versionInsertStatements(ctx, guard, {
              packageId: placeholder,
              ecosystem: input.ecosystem,
              versions: accepted,
            });
      const update =
        accepted.length === 0
          ? null
          : versionUpdateStatements(ctx, guard, {
              packageId: placeholder,
              ecosystem: input.ecosystem,
              versions: accepted,
            });
      const tags =
        input.tags === undefined
          ? null
          : distTagStatementGroups(ctx, guard, {
              packageId: placeholder,
              ecosystem: input.ecosystem,
              tags: input.tags,
              ...(input.tagNames === undefined ? {} : { tagNames: input.tagNames }),
              actorType: 'sync',
              actorId: null,
              opId: newOpId(),
            });
      const probe = bindPackage(
        compile(
          db
            .selectFrom('version')
            .select(['version', 'version_normalized'])
            .where('org_id', '=', ctx.orgId)
            .where('package_id', '=', placeholder)
            .where('status', '=', 'tombstoned')
            .where(
              sql<boolean>`version_normalized in (select value from json_each(${JSON.stringify(accepted.map((v) => v.versionNormalized))}))`,
            ),
        ),
        placeholder,
        lookup,
      );
      const tagAdvance = tags?.groups.at(-1)?.at(-1);
      const advance = tagAdvance && bindPackage(tagAdvance, placeholder, lookup);
      const groups = [
        upsert.statements,
        [probe],
        update?.statements ?? [],
        insert?.statements ?? [],
        ...(tags?.groups ?? []),
        [lookup],
      ].map((group) =>
        group.map((statement) => {
          const bound =
            statement === tagAdvance ? advance! : bindPackage(statement, placeholder, lookup);
          return /^(insert into "version" |update "version" )/i.test(bound.sql)
            ? { ...bound, sql: `${bound.sql} returning id, version` }
            : bound;
        }),
      );
      const sealBatch = (batch: Statement[]) => {
        // Each published tag state needs its own clock, including intermediate commits.
        const extraAdvance =
          advance !== undefined &&
          !batch.includes(advance) &&
          batch.some((s) => /^(insert into "dist_tag" |delete from "dist_tag" )/i.test(s.sql));
        return {
          statements: extraAdvance ? [...batch, advance!] : batch,
          extraAdvance,
        };
      };
      const planned: ReturnType<typeof sealBatch>[] = [];
      let current: Statement[] = [];
      for (const group of groups) {
        if (group.length === 0) continue;
        checkBatch(group);
        try {
          checkBatch(sealBatch([...current, ...group]).statements);
        } catch {
          planned.push(sealBatch(current));
          current = [...guard];
        }
        current.push(...group);
      }
      if (current.length > 0) planned.push(sealBatch(current));
      if (planned.reduce((n, batch) => n + batch.statements.length, 0) > MAX_STATEMENTS)
        throw new RangeError('catalogue invocation exceeds 500 statements');
      for (const batch of planned) checkBatch(batch.statements);
      const results: StatementResult[] = [];
      let statements = 0;
      for (let i = 0; i < planned.length; i++) {
        const batch = planned[i]!;
        const output = await bounded.batch(batch.statements);
        results.push(
          ...output.slice(i === 0 ? 0 : guard.length, batch.extraAdvance ? -1 : undefined),
        );
        statements += batch.statements.length;
      }
      let offset = upsert.statements.length;
      const tombstones = new Set(results[offset++]!.rows.map((row) => row['version_normalized']));
      const updateResults = results.slice(offset, offset + (update?.statements.length ?? 0));
      const updated = update?.result(updateResults);
      const changedVersions = new Set(
        updateResults.flatMap((result) =>
          result.rows.flatMap((row) =>
            typeof row['version'] === 'string' ? [row['version']] : [],
          ),
        ),
      );
      for (const version of updated?.conflicts ?? []) changedVersions.add(version);
      offset += update?.statements.length ?? 0;
      const inserted = insert?.result(results.slice(offset, offset + insert.statements.length));
      offset += insert?.statements.length ?? 0;
      const tagStatementCount = tags?.groups.reduce((sum, group) => sum + group.length, 0) ?? 0;
      const tagResult = tags?.result(results.slice(offset, offset + tagStatementCount));
      const packageId = results.at(-1)?.rows[0]?.['id'];
      if (typeof packageId !== 'string') throw new TypeError('catalogue package was not returned');
      const refused = input.versions.flatMap((v, index) => {
        const reason =
          refusals.get(index) ??
          (tombstones.has(v.versionNormalized) ? ('tombstoned' as const) : null);
        return reason === null ? [] : [{ version: v.version, reason }];
      });
      const conflicts = updated?.conflicts ?? [];
      return {
        packageId,
        inserted: inserted?.inserted ?? 0,
        updated: updated?.updated ?? 0,
        unchanged:
          input.versions.length - refused.length - changedVersions.size - (inserted?.inserted ?? 0),
        conflicts,
        refused,
        skippedTags: tagResult?.skippedTags ?? [],
        statements,
      };
    },
    async attachDist(ctx, guard, input) {
      const plan = distAttachStatements(ctx, guard, input);
      return plan.result(await bounded.batch(plan.statements));
    },
    async quarantine(ctx, guard, input) {
      const plan = quarantineStatements(ctx, guard, input);
      return plan.result(await bounded.batch(plan.statements));
    },
  };
}

type SubsetOutcome =
  AddPatternResult | RemovePatternResult | AddExplicitResult | RemoveExplicitResult;
export function subsetOutcome(outcome: SubsetOutcome): VisibilityWriteResult {
  switch (outcome) {
    case 'added':
    case 'removed':
    case 'unchanged':
      return { ok: true, opId: newOpId() };
    case 'forbidden':
      return { ok: false, reason: 'authority' };
    case 'failed':
      return { ok: false, reason: 'unclassified' };
    case 'invalid_pattern':
    case 'too_many_patterns':
    case 'not_attached':
    case 'not_eligible':
    case 'not_found':
    case 'conflict':
    case 'indeterminate':
      return { ok: false, reason: outcome };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function createVisibilityStore(
  executor: SqlExecutor,
  options: { readonly providerAnchors: readonly ProtectedHolderProvider[] },
): VisibilityStore {
  const bounded = batchExecutor(executor);
  const subset = createVisibilitySubsetRepository(bounded);
  async function status(
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<VisibilityStore['releaseQuarantine']>[2],
    to: 'active' | 'quarantined' | 'tombstoned',
    reason: 'admin_release' | 'admin_quarantine' | 'admin_tombstone',
  ): Promise<VisibilityWriteResult> {
    const { versionId, packageId, expectedStatus, manage } = input;
    const authority = actorHolds(ctx, fence, {
      permission:
        manage.kind === 'organization' ? 'org:packages:manage' : 'project:packages:manage',
      projectId: manage.kind === 'organization' ? null : manage.projectId,
      providerAnchors: options.providerAnchors,
    });
    const ownership =
      manage.kind === 'organization'
        ? sql<boolean>`1`
        : sql<boolean>`exists (
      select 1 from source as owner_source
      join project as owner_project on owner_project.id = owner_source.project_id
        and owner_project.org_id = ${ctx.orgId}
      where owner_source.id = target_package.source_id and owner_source.org_id = ${ctx.orgId}
        and owner_source.project_id = ${manage.projectId} and owner_project.status = 'active')`;
    const present = sql<boolean>`exists (
      select 1 from version as target_version
      join package as target_package on target_package.id = target_version.package_id
        and target_package.org_id = ${ctx.orgId}
      where target_version.id = ${versionId} and target_version.org_id = ${ctx.orgId}
        and target_package.id = ${packageId} and ${ownership})`;
    const statusMatches = sql<boolean>`exists (select 1 from version
      where id = ${versionId} and org_id = ${ctx.orgId} and status = ${expectedStatus})
      and ${versionTransition(expectedStatus, to, reason) ? sql`1` : sql`0`}`;
    const lease = blobLeaseNotLive(ctx, 'release_version');
    const leaseCondition = sql.join(
      lease.sql
        .split('?')
        .flatMap((part, index) =>
          index < lease.params.length
            ? [sql.raw(part), sql`${lease.params[index]}`]
            : [sql.raw(part)],
        ),
      sql``,
    );
    const blobReady =
      to !== 'active'
        ? sql<boolean>`1`
        : sql<boolean>`exists (
      select 1 from version as release_version where release_version.id = ${versionId}
        and release_version.org_id = ${ctx.orgId} and ${leaseCondition})`;
    const plan = versionStatusStatements(ctx, { versionId, to, reason });
    const outcome = await runOrgFenced(
      bounded,
      ctx,
      fence,
      assertGuard(sql<boolean>`(${present} and ${statusMatches} and ${blobReady})`, ctx),
      [
        ...assertCheck(authority),
        ...plan.statements,
        auditPendingStatement(ctx, input.audit),
        ...(input.idempotency === undefined
          ? []
          : [idempotencyInsertStatement(ctx, input.idempotency)]),
      ],
      {},
    );
    if (outcome.ok) return { ok: true, opId: plan.opId };
    if (outcome.reason === 'indeterminate') return { ok: false, reason: outcome.reason };
    const holds = async (condition: Guard) => {
      const [row] = await bounded.all<{ held: number }>(
        compile(db.selectNoFrom(sql<number>`(${condition}) is 1`.as('held'))),
      );
      return row?.held === 1;
    };
    try {
      if (!(await holds(present))) return { ok: false, reason: 'not_found' };
      if (!(await holds(statusMatches))) return { ok: false, reason: 'conflict' };
      if (!(await holds(authority))) return { ok: false, reason: 'authority' };
      if (!(await holds(blobReady))) return { ok: false, reason: 'conflict' };
      if (
        input.idempotency !== undefined &&
        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))
      )
        return { ok: false, reason: 'conflict' };
    } catch {
      return { ok: false, reason: 'unclassified' };
    }
    return { ok: false, reason: outcome.reason };
  }
  return {
    ...createVisibilityAttachRepository(bounded, options),
    async addPattern(ctx, fence, input) {
      return subsetOutcome(
        await subset.addPattern(ctx, fence, { ...input, providerAnchors: options.providerAnchors }),
      );
    },
    async removePattern(ctx, fence, input) {
      return subsetOutcome(
        await subset.removePattern(ctx, fence, {
          ...input,
          providerAnchors: options.providerAnchors,
        }),
      );
    },
    async addExplicit(ctx, fence, input) {
      return subsetOutcome(
        await subset.addExplicit(ctx, fence, {
          ...input,
          providerAnchors: options.providerAnchors,
        }),
      );
    },
    async removeExplicit(ctx, fence, input) {
      return subsetOutcome(
        await subset.removeExplicit(ctx, fence, {
          ...input,
          providerAnchors: options.providerAnchors,
        }),
      );
    },
    quarantineVersion: (ctx, fence, input) =>
      status(ctx, fence, input, 'quarantined', input.reason),
    releaseQuarantine: (ctx, fence, input) => status(ctx, fence, input, 'active', 'admin_release'),
    tombstoneVersion: (ctx, fence, input) => status(ctx, fence, input, 'tombstoned', input.reason),
  };
}
