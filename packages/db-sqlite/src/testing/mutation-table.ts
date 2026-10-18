import { expect } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { sql } from 'kysely';
import type { SyncResult } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db, freshGroupMembership, guardAliases, guardBindings } from '../kysely.js';
import type { Expression, Kysely, SqlBool } from 'kysely';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { ProtectedHolderProvider } from '../kysely.js';
import {
  holdsPermission,
  lookupSessionStatement,
  lookupTokenStatement,
  permissionRows,
} from '../repositories/access.js';
import { blobEligibleCondition } from '../repositories/blob-references.js';
import { actorHolds } from '../repositories/actor-authority.js';
import { servicePrincipalAuthorityGuard } from '../repositories/service-principal-authority.js';
import {
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
} from '../repositories/catalogue-predicates.js';
import {
  createCatalogueWriteGuard,
  packageUpsertStatements,
} from '../repositories/catalogue-write-package.js';
import { versionInsertStatements } from '../repositories/catalogue-write-version-insert.js';
import { versionUpdateStatements } from '../repositories/catalogue-write-version-update.js';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { distTagStatements, type DistTagRequest } from '../repositories/catalogue-write-tags.js';
import { coveredByRegisteredNames, sourceActivatable } from '../repositories/registered-name.js';
import { epochReadStatement } from '../repositories/cache-epoch.js';
import { dueStatement } from '../repositories/source.js';
import { revokeAllForUserStatement, sessionInsertStatement } from '../repositories/session.js';
import type { TwoOrganizations } from '../contract/two-organizations.js';
import { openMigratedDatabase } from './migrated-database.js';

export interface CaseContext {
  readonly executor: SqlExecutor;
  readonly orgs: TwoOrganizations;
  /** Every statement a case executes goes through here, so the mutation reaches the SQL that runs. */
  mutate<S extends Statement>(statement: S): S;
}

export interface ContractCase {
  readonly name: string;
  run(context: CaseContext): Promise<void>;
}

/** A named org predicate found in the compiled SQL by `locate` and replaced by `neutral`; a `?` kept in `neutral` keeps the parameter list aligned. */
export interface OrgPredicate {
  readonly name: string;
  readonly locate: RegExp;
  readonly neutral: string;
  readonly caseName: string;
  /** Exact number of matches the case must execute. */
  readonly copies?: number;
  /** Copy index to the reason no case can tell that copy from its twin. */
  readonly waivedCopies?: Readonly<Record<number, string>>;
}

/** An `org_id` comparison that is part of the statement's shape, not a scoping predicate. */
export interface OrgWaiver {
  readonly locate: RegExp;
  readonly reason: string;
}

export interface DecisionCheck {
  readonly name: string;
  readonly pattern: RegExp;
  readonly expected: number;
  build(): readonly Statement[];
}

export interface MutationEntry {
  readonly builder: string;
  readonly file: string;
  readonly predicates: readonly OrgPredicate[];
  readonly cases: readonly ContractCase[];
  readonly waivers?: readonly OrgWaiver[];
  readonly decisions?: readonly DecisionCheck[];
}

export type Verdict = 'killed' | 'vacuous' | 'baseline-failed' | 'not-reached' | 'errored';

export interface Judgement {
  readonly verdict: Verdict;
  readonly detail: string;
}

export interface JudgeOptions {
  readonly strip?: boolean;
}

type Mutator = <S extends Statement>(statement: S) => S;

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
}

/** Replaces only the match numbered `copy` (counting from `firstIndex` across statements). */
export function stripPredicate(
  statement: Statement,
  predicate: OrgPredicate,
  copy: number,
  firstIndex = 0,
): { readonly statement: Statement; readonly matches: number } {
  let index = firstIndex;
  let stripped = false;
  const sql = statement.sql.replace(globalPattern(predicate.locate), (found) => {
    const hit = index === copy;
    index += 1;
    stripped ||= hit;
    return hit ? predicate.neutral : found;
  });
  return {
    statement: stripped ? { sql, params: statement.params } : statement,
    matches: index - firstIndex,
  };
}

function isAssertion(error: unknown): boolean {
  return error instanceof Error && error.name === 'AssertionError';
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.split('\n')[0] ?? ''}` : 'thrown';
}

async function runCase(contractCase: ContractCase, mutate: Mutator): Promise<void> {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    if (database.orgs === null) throw new Error('organizations were not seeded');
    await contractCase.run({ executor: database.executor, orgs: database.orgs, mutate });
  } finally {
    await database.close();
  }
}

async function recordCase(contractCase: ContractCase): Promise<readonly Statement[]> {
  const seen: Statement[] = [];
  await runCase(contractCase, (statement) => {
    seen.push(statement);
    return statement;
  });
  return seen;
}

function countMatches(statements: readonly Statement[], predicate: OrgPredicate): number {
  const pattern = globalPattern(predicate.locate);
  return statements.reduce((sum, { sql }) => sum + (sql.match(pattern)?.length ?? 0), 0);
}

/**
 * Runs the predicate's named case unmutated (must pass), then once per match of the locator with
 * only that match stripped (each must fail an assertion unless waived with a reason).
 */
export async function judge(
  entry: MutationEntry,
  predicate: OrgPredicate,
  options: JudgeOptions = {},
): Promise<Judgement> {
  const contractCase = entry.cases.find((candidate) => candidate.name === predicate.caseName);
  if (contractCase === undefined) {
    return { verdict: 'errored', detail: `no case named ${predicate.caseName}` };
  }
  let executed: readonly Statement[];
  try {
    executed = await recordCase(contractCase);
  } catch (error) {
    return { verdict: 'baseline-failed', detail: describeError(error) };
  }
  const total = countMatches(executed, predicate);
  if (total === 0 || options.strip === false) {
    return { verdict: 'not-reached', detail: 'the locator matched no executed statement' };
  }
  if (predicate.copies !== undefined && predicate.copies !== total) {
    return {
      verdict: 'errored',
      detail: `the locator matched ${String(total)} times, expected ${String(predicate.copies)}`,
    };
  }
  for (let copy = 0; copy < total; copy += 1) {
    if (predicate.waivedCopies?.[copy] !== undefined) continue;
    let seen = 0;
    const mutate: Mutator = (statement) => {
      const result = stripPredicate(statement, predicate, copy, seen);
      seen += result.matches;
      return result.statement as typeof statement;
    };
    const label = `copy ${String(copy + 1)} of ${String(total)}`;
    try {
      await runCase(contractCase, mutate);
    } catch (error) {
      if (isAssertion(error)) continue;
      return { verdict: 'errored', detail: `${label}: ${describeError(error)}` };
    }
    return { verdict: 'vacuous', detail: `${label}: the case passes without it` };
  }
  return { verdict: 'killed', detail: `${String(total)} copies` };
}

const ORG_COMPARISON = /\borg_id"?\s*(?:=|<>|!=|\bis\b)/gi;

/** `org_id` comparisons in the statements the entry's cases execute that no predicate or waiver covers. */
export async function unaccountedOrgComparisons(entry: MutationEntry): Promise<string[]> {
  const covers = [
    ...entry.predicates.map((predicate) => predicate.locate),
    ...(entry.waivers ?? []).map((waiver) => waiver.locate),
  ].map(globalPattern);
  const unaccounted: string[] = [];
  for (const contractCase of entry.cases) {
    const statements = await recordCase(contractCase);
    for (const { sql } of statements) {
      const spans = covers.flatMap((cover) =>
        [...sql.matchAll(cover)].map((m) => [m.index, m.index + m[0].length] as const),
      );
      for (const comparison of sql.matchAll(ORG_COMPARISON)) {
        const at = comparison.index;
        if (!spans.some(([start, end]) => start <= at && at < end)) {
          unaccounted.push(
            `${contractCase.name}: ...${sql.slice(Math.max(0, at - 24), at + 32)}...`,
          );
        }
      }
    }
  }
  return unaccounted;
}

export function countDecisions(check: DecisionCheck, statements: readonly Statement[]): number {
  const pattern = globalPattern(check.pattern);
  return statements.reduce(
    (sum, statement) => sum + (statement.sql.match(pattern)?.length ?? 0),
    0,
  );
}

/** Makes the first deciding statement read the clock a second time, in its own SQL. */
export function plantRepeatedDecision(
  check: DecisionCheck,
  statements: readonly Statement[],
): readonly Statement[] {
  const pattern = new RegExp(check.pattern.source, check.pattern.flags.replace('g', ''));
  let planted = false;
  return statements.map((statement) => {
    if (planted) return statement;
    const sql = statement.sql.replace(pattern, (found) => {
      planted = true;
      return `coalesce(${found}, ${found})`;
    });
    return planted ? { sql, params: statement.params } : statement;
  });
}

const BUILDER_RETURN =
  /\b(?:Guard|Statement|ScalarStatement|FenceGuard|LeaseGuardCondition|EligibleCondition|\w*Plan)\b|Expression<|SelectQueryBuilder|Statement\[\]/;
const BUILDER_NAME = /(?:Condition|Statements?|Guard)$/;

function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return source.length;
}

function isBuilder(name: string, annotation: string | undefined): boolean {
  if (name.startsWith('create')) return false;
  if (annotation === undefined) return true;
  return (
    !annotation.startsWith('Promise<') &&
    (BUILDER_RETURN.test(annotation) || BUILDER_NAME.test(name))
  );
}

/** Exported functions and arrow constants of a source that build SQL statements, guards or predicates. */
export function exportedBuilders(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^export (?:async )?function (\w+)\s*(?:<[^(]*>)?\(/gm)) {
    const close = closingParen(source, (match.index ?? 0) + match[0].length - 1);
    const annotation = /^\s*:\s*([^{]*?)\s*\{/s.exec(source.slice(close + 1, close + 400))?.[1];
    if (isBuilder(match[1] ?? '', annotation)) found.push(match[1] ?? '');
  }
  for (const match of source.matchAll(
    /^export const (\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\s*)?(?:<[^(]*>)?\(/gm,
  )) {
    const close = closingParen(source, (match.index ?? 0) + match[0].length - 1);
    const after = source.slice(close + 1, close + 400);
    const annotation = /^\s*:\s*([^{=]*?)\s*(?:=>|\{)/s.exec(after)?.[1];
    if (/^\s*(?::[^{=]*?)?\s*(?:=>|\{)/s.test(after) && isBuilder(match[1] ?? '', annotation)) {
      found.push(match[1] ?? '');
    }
  }
  return found;
}

/** Builders a source exports, including relative re-exports of builders from other sources. */
export function builderNames(
  file: string,
  sources: Readonly<Record<string, string>>,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const source = sources[file];
  if (source === undefined || seen.has(file)) return [];
  const names = exportedBuilders(source);
  for (const match of source.matchAll(
    /^export \{([^}]*)\} from '(\.{1,2}\/[^']+)'|^export \* from '(\.{1,2}\/[^']+)'/gm,
  )) {
    const specifier = match[2] ?? match[3] ?? '';
    const target = new URL(specifier.replace(/\.js$/, '.ts'), `file:///${file}`).pathname.slice(1);
    const upstream = builderNames(target, sources, new Set([...seen, file]));
    if (match[1] === undefined) {
      names.push(...upstream);
      continue;
    }
    for (const item of match[1].split(',')) {
      const [original, alias] = item.trim().split(/\s+as\s+/);
      if (original !== undefined && original !== '' && upstream.includes(original)) {
        names.push(alias ?? original);
      }
    }
  }
  return names;
}

export interface Seed {
  (sql: string, ...params: (string | number | null)[]): Promise<void>;
}

export function seeder(executor: SqlExecutor): Seed {
  return async (sql, ...params) => {
    await executor.batch([{ sql, params }]);
  };
}

export function orgOf(context: CaseContext): {
  readonly own: OrgContext;
  readonly foreign: OrgContext;
} {
  return { own: context.orgs.a, foreign: context.orgs.b };
}

const OWN_TARGET =
  'the check of the tag that points at a version of this organization: stripping it cannot change the outcome';
const ABORTED_BY_CHECK =
  'emitted after a failing check, so the batch never runs it; the sync actor scenario runs the same statements';
const NOT_NULL = '(? is not null)';
const ALWAYS = '(1 = 1)';
const A_JOB = '01J0JOB00000000000000000M1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0M01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const ref = (table: string, column: string, tail: string): RegExp =>
  new RegExp(`(?<![\\w".])"?${table}"?\\."?${column}"? = ${tail}`);

async function seedProject(seed: Seed, id: string, orgId: string): Promise<void> {
  await seed(
    'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
    id,
    orgId,
    id.toLowerCase(),
    id,
    'active',
  );
}

async function seedSource(
  seed: Seed,
  id: string,
  orgId: string,
  type: string,
  ecosystem = 'composer',
): Promise<void> {
  await seed(
    'INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)',
    id,
    orgId,
    id,
    ecosystem,
    type,
  );
}

async function seedPackage(
  seed: Seed,
  id: string,
  orgId: string,
  sourceId: string,
  name: string,
  ecosystem = 'composer',
): Promise<void> {
  await seed(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    id,
    orgId,
    sourceId,
    ecosystem,
    name,
  );
}

async function seedUser(seed: Seed, id: string, orgId: string): Promise<void> {
  await seed(
    'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    id,
    orgId,
    `${id.toLowerCase()}@example.test`,
  );
}

async function seedVersion(
  seed: Seed,
  id: string,
  orgId: string,
  packageId: string,
  version: string,
): Promise<void> {
  await seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, 'upstream', '{}')`,
    id,
    orgId,
    packageId,
    version,
    version,
    '2020-01-01T00:00:00.000Z',
  );
}

async function ids(context: CaseContext, query: Parameters<typeof compile>[0]): Promise<string[]> {
  const rows = await context.executor.all<{ id: string }>(context.mutate(compile(query)));
  return rows.map((row) => row.id).sort();
}

const packageRows = () =>
  db
    .selectFrom('package as pkg')
    .innerJoin('source as src', 'src.id', 'pkg.source_id')
    .select('pkg.id');

const proxyShadowedByForeignPackage: ContractCase = {
  name: 'a same-named package of another organization does not shadow a proxy package',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-PROXY', own.orgId, 'packagist_proxy');
    await seedSource(seed, 'S-FOREIGN', foreign.orgId, 'vcs');
    await seedPackage(seed, 'K-PROXY', own.orgId, 'S-PROXY', 'acme/a');
    await seedPackage(seed, 'K-FOREIGN', foreign.orgId, 'S-FOREIGN', 'acme/a');
    expect(
      await ids(
        context,
        packageRows()
          .where('pkg.org_id', '=', own.orgId)
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' })),
      ),
    ).toEqual(['K-PROXY']);
  },
};

const proxyBlockedByForeignName: ContractCase = {
  name: 'a registered name of another organization does not block a proxy package',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-PROXY', own.orgId, 'packagist_proxy');
    await seedSource(seed, 'S-FOREIGN', foreign.orgId, 'vcs');
    await seedPackage(seed, 'K-PROXY', own.orgId, 'S-PROXY', 'acme/a');
    await seed(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      'R-FOREIGN',
      foreign.orgId,
      'S-FOREIGN',
      'composer',
      'acme/*',
    );
    expect(
      await ids(
        context,
        packageRows()
          .where('pkg.org_id', '=', own.orgId)
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' })),
      ),
    ).toEqual(['K-PROXY']);
  },
};

function attachedCase(mismatched: 'attachment' | 'source' | 'project'): ContractCase {
  return {
    name: `an attachment whose ${mismatched} belongs to another organization is not attached`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedProject(seed, 'P1', mismatched === 'project' ? foreign.orgId : own.orgId);
      await seedSource(seed, 'S1', mismatched === 'source' ? foreign.orgId : own.orgId, 'vcs');
      await seed(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        mismatched === 'attachment' ? foreign.orgId : own.orgId,
        'P1',
        'S1',
      );
      const rows = db
        .selectFrom('project_source as x')
        .innerJoin('source as sx', 'sx.id', 'x.source_id')
        .select('x.source_id as id')
        .where(
          attachedSourceCondition(
            own,
            col('x.project_id'),
            col('x.source_id'),
            col('sx.ecosystem'),
          ),
        );
      expect(await ids(context, rows)).toEqual([]);
    },
  };
}

const readTimeForeignProject: ContractCase = {
  name: 'a project of another organization does not make a package readable',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    await seedSource(seed, 'S1', own.orgId, 'vcs');
    await seedPackage(seed, 'K1', own.orgId, 'S1', 'acme/a');
    expect(
      await ids(
        context,
        packageRows().where(
          readTimeCondition(own, sql`${'P-FOREIGN'}`, { package: 'pkg', source: 'src' }),
        ),
      ),
    ).toEqual([]);
  },
};

const coveredByForeignName: ContractCase = {
  name: 'a registered name of another organization does not cover a key',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S1', own.orgId, 'vcs');
    await seed(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      'R-FOREIGN',
      foreign.orgId,
      'S1',
      'composer',
      'acme/*',
    );
    const rows = await context.executor.all<{ held: number }>(
      context.mutate(
        compile(
          db.selectNoFrom(
            sql<number>`(${coveredByRegisteredNames(own, 'S1' as never, 'acme/a')})`.as('held'),
          ),
        ),
      ) as never,
    );
    expect(rows[0]?.held).toBe(0);
  },
};

function activatableCase(foreignRow: 'source' | 'name'): ContractCase {
  return {
    name: `a ${foreignRow} of another organization does not make a source activatable`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedSource(seed, 'S1', foreignRow === 'source' ? foreign.orgId : own.orgId, 'vcs');
      await seed(
        'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
        'R1',
        foreign.orgId,
        'S1',
        'composer',
        'acme/*',
      );
      const rows = await context.executor.all<{ held: number }>(
        context.mutate(
          compile(
            db.selectNoFrom(sql<number>`(${sourceActivatable(own, 'S1' as never)})`.as('held')),
          ),
        ) as never,
      );
      expect(rows[0]?.held).toBe(0);
    },
  };
}

async function seedTagFixture(
  context: CaseContext,
  options: { packageOrg: string; versionOrg: string },
): Promise<void> {
  const seed = seeder(context.executor);
  const { own } = orgOf(context);
  await seed(
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
      VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
    A_JOB,
    own.orgId,
    `k:${A_JOB}`,
    OWNER,
    FUTURE,
  );
  await seedSource(seed, 'S-NPM', options.packageOrg, 'npm_registry', 'npm');
  await seedPackage(seed, 'K-NPM', options.packageOrg, 'S-NPM', 'widget', 'npm');
  await seedVersion(seed, 'V1', options.versionOrg, 'K-NPM', '1.0.0');
  await seedVersion(seed, 'V2', orgOf(context).own.orgId, 'K-NPM', '2.0.0');
}

function tagRequest(tags: Record<string, string>, actorType: 'user' | 'sync'): DistTagRequest {
  return {
    packageId: 'K-NPM',
    ecosystem: 'npm',
    tags,
    actorType,
    actorId: null,
    opId: '01J0OP0000000000000000M001',
  };
}

async function applyTagPlan(
  context: CaseContext,
  tags: Record<string, string>,
  actorType: 'user' | 'sync',
): Promise<SyncResult | null> {
  const { own } = orgOf(context);
  const guard = createCatalogueWriteGuard(own, { id: A_JOB, owner: OWNER, fence: 3 });
  const plan = distTagStatements(own, guard, tagRequest(tags, actorType));
  try {
    return plan.result(
      await context.executor.batch(plan.statements.map((statement) => context.mutate(statement))),
    );
  } catch (error) {
    if (!String(error).includes(ACCESS_MUTATION_GUARD_CONSTRAINT)) throw error;
    return null;
  }
}

async function tagCount(context: CaseContext): Promise<number> {
  const rows = await context.executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM dist_tag WHERE package_id = ?',
    params: ['K-NPM'],
  });
  return rows[0]?.n ?? -1;
}

async function historyCount(context: CaseContext): Promise<number> {
  const rows = await context.executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM dist_tag_history WHERE package_id = ?',
    params: ['K-NPM'],
  });
  return rows[0]?.n ?? -1;
}

const tagOnForeignPackage: ContractCase = {
  name: 'a dist tag is not written onto a package of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedTagFixture(context, { packageOrg: foreign.orgId, versionOrg: own.orgId });
    expect(await applyTagPlan(context, { latest: '1.0.0' }, 'user')).toBeNull();
    expect(await tagCount(context)).toBe(0);
  },
};

const tagToForeignVersion: ContractCase = {
  name: 'a dist tag does not point at a version of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: foreign.orgId });
    expect(await applyTagPlan(context, { latest: '2.0.0', next: '1.0.0' }, 'user')).toBeNull();
    expect(await tagCount(context)).toBe(0);
    const synced = await applyTagPlan(context, { next: '1.0.0' }, 'sync');
    expect(synced?.skippedTags).toEqual(['next']);
    expect(await tagCount(context)).toBe(0);
    expect(await historyCount(context)).toBe(0);
  },
};

const tagRemovalSpares: ContractCase = {
  name: 'removing absent dist tags leaves rows of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: own.orgId });
    await seeder(context.executor)(
      'INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)',
      foreign.orgId,
      'K-NPM',
      'old',
      'V1',
    );
    await applyTagPlan(context, {}, 'sync');
    expect(await tagCount(context)).toBe(1);
    expect(await historyCount(context)).toBe(0);
  },
};

const tagPlanStatements = (tagCountInRequest: number): readonly Statement[] => {
  const org = { orgId: '01J00000000000000000000A0A' } as OrgContext;
  const guard = createCatalogueWriteGuard(org, { id: A_JOB, owner: OWNER, fence: 3 });
  const tags = Object.fromEntries(
    Array.from({ length: tagCountInRequest }, (_, index) => [`tag${String(index)}`, '1.0.0']),
  );
  return distTagStatements(org, guard, tagRequest(tags, 'sync')).statements;
};

function revisionClockCheck(tagsInRequest: number): DecisionCheck {
  return {
    name: `the package revision clock is read once for ${String(tagsInRequest)} tags`,
    pattern: /max\(\s*unixepoch\('now', 'subsec'\)/,
    expected: 1,
    build: () => tagPlanStatements(tagsInRequest),
  };
}

const sessionOfForeignUser = async (context: CaseContext): Promise<void> => {
  const seed = seeder(context.executor);
  const { foreign } = orgOf(context);
  await seedUser(seed, 'U-FOREIGN', foreign.orgId);
  await seed(
    `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    'SES-FOREIGN',
    foreign.orgId,
    'U-FOREIGN',
    HASH,
    OTHER_HASH,
    FUTURE,
  );
};

const revokeSparesForeignSessions: ContractCase = {
  name: 'revoking all sessions of a user leaves the sessions of another organization',
  async run(context) {
    const { own } = orgOf(context);
    await sessionOfForeignUser(context);
    await context.executor.batch([
      context.mutate(revokeAllForUserStatement(own, 'U-FOREIGN', '2030-01-01T00:00:00.000Z', [])),
    ]);
    const rows = await context.executor.all<{ revoked_at: string | null }>({
      sql: 'SELECT revoked_at FROM session WHERE id = ?',
      params: ['SES-FOREIGN'],
    });
    expect(rows[0]?.revoked_at).toBeNull();
  },
};

const sessionNotMintedForForeignUser: ContractCase = {
  name: 'a session is not minted for a user of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await context.executor.all(
      context.mutate(
        sessionInsertStatement(
          own,
          {
            id: 'SES-NEW',
            userId: 'U-FOREIGN',
            identityId: null,
            secretHash: HASH,
            csrfHash: OTHER_HASH,
            now: '2030-01-01T00:00:00.000Z',
            expiresAt: FUTURE,
            ip: null,
            userAgent: null,
          },
          [],
        ),
      ),
    );
    const rows = await context.executor.all<{ n: number }>({
      sql: 'SELECT count(*) AS n FROM session',
      params: [],
    });
    expect(rows[0]?.n).toBe(0);
  },
};

const sessionLookupIgnoresForeign: ContractCase = {
  name: 'a session lookup does not return a session of another organization',
  async run(context) {
    const { own } = orgOf(context);
    await sessionOfForeignUser(context);
    const rows = await context.executor.all(
      context.mutate(
        lookupSessionStatement(own, {
          secretHash: HASH,
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: [],
        }),
      ),
    );
    expect(rows).toEqual([]);
  },
};

const sessionJoinsForeignUser: ContractCase = {
  name: 'a session does not join a user of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await seed(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      'SES-OWN',
      own.orgId,
      'U-FOREIGN',
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    expect(await sessionLookupRows(context)).toEqual([]);
  },
};

const sessionJoinsForeignIdentity: ContractCase = {
  name: 'a session does not join an identity of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-OWN', own.orgId);
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES ('I-FOREIGN', ?, 'U-OWN', 'oidc', 'sub', 'x@example.test')",
      foreign.orgId,
    );
    await seed(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'SES-OWN',
      own.orgId,
      'U-OWN',
      'I-FOREIGN',
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    expect(await sessionLookupRows(context)).toEqual([]);
  },
};

async function sessionLookupRows(context: CaseContext): Promise<unknown[]> {
  return context.executor.all(
    context.mutate(
      lookupSessionStatement(orgOf(context).own, {
        secretHash: HASH,
        boundary: 'organization',
        projectSlug: null,
        providerAnchors: [],
      }),
    ),
  );
}

const tokenJoinsForeignUser: ContractCase = {
  name: 'a token does not join a user of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at)
        VALUES (?, ?, 'pat', ?, ?, 1, 'ci', '["read"]', ?, ?)`,
      'TOK-OWN',
      own.orgId,
      'abcdefabcdef',
      HASH,
      'U-FOREIGN',
      FUTURE,
    );
    const rows = await context.executor.all<{ principal_status: string | null }>(
      context.mutate(
        lookupTokenStatement(own, {
          selector: 'abcdefabcdef',
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: [],
        }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.principal_status).toBeNull();
  },
};

const tokenLookupIgnoresForeign: ContractCase = {
  name: 'a token lookup does not return a token of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at)
        VALUES (?, ?, 'pat', ?, ?, 1, 'ci', '["read"]', ?, ?)`,
      'TOK-FOREIGN',
      foreign.orgId,
      'abcdefabcdef',
      HASH,
      'U-FOREIGN',
      FUTURE,
    );
    const rows = await context.executor.all(
      context.mutate(
        lookupTokenStatement(own, {
          selector: 'abcdefabcdef',
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: [],
        }),
      ),
    );
    expect(rows).toEqual([]);
  },
};

const epochReadSparesForeign: ContractCase = {
  name: 'an epoch read returns only the version of the organization',
  async run(context) {
    const { own } = orgOf(context);
    const rows = await context.executor.all(context.mutate(epochReadStatement(own)));
    expect(rows).toHaveLength(1);
  },
};

const dueSparesForeignSources: ContractCase = {
  name: 'the due source list excludes sources of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    for (const [id, orgId] of [
      ['S-OWN', own.orgId],
      ['S-FOREIGN', foreign.orgId],
    ] as const) {
      await seedSource(seed, id, orgId, 'vcs');
      await seed('UPDATE source SET next_poll_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', id);
    }
    const rows = await context.executor.all<{ id: string }>(context.mutate(dueStatement(own, 10)));
    expect(rows.map((row) => row.id)).toEqual(['S-OWN']);
  },
};

type Layer = 'user' | 'grant' | 'role' | 'permission' | 'identity' | 'binding';

const LAYERS: readonly Layer[] = ['user', 'grant', 'role', 'permission', 'identity', 'binding'];
const CHAIN: readonly Layer[] = ['user', 'grant', 'role', 'permission'];
const ANCHORS: readonly ProtectedHolderProvider[] = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
  { provider: 'oidc2', anchor: 'oidc:https://idp2.example.test', emailAuthoritative: true },
];
const ORG_PERMISSION = 'org:settings:write';
const PROJECT_PERMISSION = 'project:packages:write';

const loose = db as unknown as Kysely<Record<string, Record<string, unknown>>>;

interface Subject {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * A user who holds a permission through email grants and a verified identity. Every row from the
 * `mismatched` layer down the user, grant, role, permission chain belongs to the other organization,
 * as does the identity or binding when one of those is named.
 */
async function seedSubject(
  context: CaseContext,
  key: string,
  options: { projectId?: string; mismatched?: Layer } = {},
): Promise<Subject> {
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  const from = options.mismatched === undefined ? -1 : CHAIN.indexOf(options.mismatched);
  const chainOrg = (layer: Layer): string =>
    from >= 0 && CHAIN.indexOf(layer) >= from ? foreign.orgId : own.orgId;
  const email = `${key}@example.test`;
  const userId = `U-${key}`;
  const provider = options.mismatched === 'binding' ? 'oidc2' : 'oidc';
  const scope = options.projectId === undefined ? 'organization' : 'project';
  await seed(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    userId,
    chainOrg('user'),
    email,
    'active',
  );
  await seed(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    `I-${key}`,
    options.mismatched === 'identity' ? foreign.orgId : own.orgId,
    userId,
    provider,
    `sub-${key}`,
    email,
    new Date(Date.now() - 60_000).toISOString(),
  );
  await seed(
    'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
    `R-${key}`,
    chainOrg('role'),
    `role-${key}`,
    key,
    scope,
  );
  await seed(
    'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
    chainOrg('permission'),
    `R-${key}`,
    options.projectId === undefined ? ORG_PERMISSION : PROJECT_PERMISSION,
  );
  await seed(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    `G-${key}`,
    chainOrg('grant'),
    'email',
    email,
    scope,
    options.projectId ?? null,
    `R-${key}`,
  );
  const now = new Date().toISOString();
  await seed(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `SES-${key}`,
    own.orgId,
    userId,
    key.length === 0 ? HASH : `${key.padEnd(64, 'c')}`.slice(0, 64),
    OTHER_HASH,
    now,
    now,
    FUTURE,
  );
  return { userId, sessionId: `SES-${key}` };
}

async function seedBindings(context: CaseContext): Promise<void> {
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  await seed(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    own.orgId,
    'oidc',
    ANCHORS[0]?.anchor ?? '',
  );
  await seed(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    foreign.orgId,
    'oidc2',
    ANCHORS[1]?.anchor ?? '',
  );
}

async function held(
  context: CaseContext,
  guard: Expression<SqlBool>,
  mutated: boolean,
): Promise<boolean> {
  const statement = compile(db.selectNoFrom(sql<number>`(${guard})`.as('held')));
  const rows = await context.executor.all<{ held: number }>(
    mutated ? context.mutate(statement) : statement,
  );
  return rows[0]?.held === 1;
}

function fenceOf(subject: Subject): MutationFence {
  return mutationFence(
    { userId: subject.userId, sessionId: subject.sessionId } as unknown as AuthenticatedActor,
    {},
  );
}

const rowsCase = (layer: Layer): ContractCase => ({
  name: `a ${layer} row of another organization yields no permission row`,
  async run(context) {
    const { own } = orgOf(context);
    await seedBindings(context);
    const control = await seedSubject(context, 'ok');
    const bad = await seedSubject(context, 'bad', { mismatched: layer });
    const rowsOf = (userId: string, mutated: boolean) => {
      const statement = compile(
        loose
          .selectFrom(permissionRows(own, userId, null, ANCHORS).as('pr'))
          .select('pr.permission' as never),
      );
      return context.executor.all(mutated ? context.mutate(statement) : statement);
    };
    expect((await rowsOf(control.userId, false)).length).toBeGreaterThan(0);
    expect(await rowsOf(bad.userId, true)).toEqual([]);
  },
});

const holdsForeignProject: ContractCase = {
  name: 'a project of another organization is not an active project for holdsPermission',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    await seedProject(seed, 'P-OWN', own.orgId);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    const control = await seedSubject(context, 'ok', { projectId: 'P-OWN' });
    const bad = await seedSubject(context, 'bad', { projectId: 'P-FOREIGN' });
    const guardFor = (subject: Subject, projectId: string) =>
      holdsPermission(own, {
        userId: subject.userId,
        permission: PROJECT_PERMISSION,
        projectId,
        providerAnchors: ANCHORS,
        projectState: 'active',
      });
    expect(await held(context, guardFor(control, 'P-OWN'), false)).toBe(true);
    expect(await held(context, guardFor(bad, 'P-FOREIGN'), true)).toBe(false);
  },
};

const actorSessionIdentityOfForeignOrg: ContractCase = {
  name: 'a session bound to an identity of another organization does not make the actor hold a permission',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    const control = await seedSubject(context, 'ok');
    const bad = await seedSubject(context, 'bad');
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES ('I-FOREIGN', ?, ?, 'oidc', 'sub-foreign', 'bad@example.test')",
      foreign.orgId,
      bad.userId,
    );
    await seed('UPDATE session SET identity_id = ? WHERE id = ?', 'I-FOREIGN', bad.sessionId);
    const guardFor = (subject: Subject) =>
      actorHolds(own, fenceOf(subject), {
        permission: ORG_PERMISSION,
        projectId: null,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor(control), false)).toBe(true);
    expect(await held(context, guardFor(bad), true)).toBe(false);
  },
};

const actorArchivedForeignProject: ContractCase = {
  name: 'a project of another organization does not exist for an archived-project check',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    await seedProject(seed, 'P-OWN', own.orgId);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    const control = await seedSubject(context, 'ok', { projectId: 'P-OWN' });
    const bad = await seedSubject(context, 'bad', { projectId: 'P-FOREIGN' });
    const guardFor = (subject: Subject, projectId: string) =>
      actorHolds(own, fenceOf(subject), {
        permission: PROJECT_PERMISSION,
        projectId,
        allowArchived: true,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor(control, 'P-OWN'), false)).toBe(true);
    expect(await held(context, guardFor(bad, 'P-FOREIGN'), true)).toBe(false);
  },
};

async function guardPasses(
  context: CaseContext,
  guard: readonly Statement[],
  mutated: boolean,
): Promise<boolean> {
  try {
    await context.executor.batch(
      guard.map((statement) => (mutated ? context.mutate(statement) : statement)),
    );
    return true;
  } catch (error) {
    if (!String(error).includes(ACCESS_MUTATION_GUARD_CONSTRAINT)) throw error;
    return false;
  }
}

const spCoversForeignPermission: ContractCase = {
  name: 'a permission row of another organization does not count as covered',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    const subject = await seedSubject(context, 'ok');
    const seed = seeder(context.executor);
    const insertPermission =
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)';
    await seed(insertPermission, own.orgId, 'R-ok', 'org:users:read');
    await seed(insertPermission, foreign.orgId, 'R-ok', 'org:roles:read');
    const guardFor = (covers: readonly string[]) =>
      servicePrincipalAuthorityGuard(own, fenceOf(subject), {
        permission: ORG_PERMISSION,
        projectId: null,
        organizationAdmin: false,
        covers,
        providerAnchors: ANCHORS,
      });
    expect(await guardPasses(context, guardFor(['org:users:read']), false)).toBe(true);
    expect(await guardPasses(context, guardFor(['org:roles:read']), true)).toBe(false);
  },
};

const PERMISSION_ROWS =
  'inside permissionRows, which has its own registration (access.ts#permissionRows)';

const lookupSessionEntry: MutationEntry = {
  builder: 'lookupSessionStatement',
  file: 'repositories/access.ts',
  cases: [sessionLookupIgnoresForeign, sessionJoinsForeignUser, sessionJoinsForeignIdentity],
  waivers: [{ locate: /"guard_\w+"\."org_id" = /, reason: PERMISSION_ROWS }],
  predicates: [
    {
      name: 'session rows are scoped to the organization',
      locate: ref('s', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: sessionLookupIgnoresForeign.name,
    },
    {
      name: 'the user joins within the session organization',
      locate: ref('u', 'org_id', '"s"\\."org_id"'),
      neutral: ALWAYS,
      caseName: sessionJoinsForeignUser.name,
    },
    {
      name: 'the identity joins within the session organization',
      locate: ref('i', 'org_id', '"s"\\."org_id"'),
      neutral: ALWAYS,
      caseName: sessionJoinsForeignIdentity.name,
    },
  ],
};

const lookupTokenEntry: MutationEntry = {
  builder: 'lookupTokenStatement',
  file: 'repositories/access.ts',
  cases: [tokenLookupIgnoresForeign, tokenJoinsForeignUser],
  waivers: [
    { locate: /"guard_\w+"\."org_id" = /, reason: PERMISSION_ROWS },
    {
      locate: /\bev_[il]\.org_id = \?/,
      reason:
        'validation evidence subqueries are also bound by the token identity or user id; no case yet pairs them with a row of another organization',
    },
    {
      locate: ref('spp', 'org_id', '\\?'),
      reason:
        'service permission rows are also bound by the principal id; no case yet pairs them with a row of another organization',
    },
    {
      locate: ref('sp', 'org_id', '"t"\\."org_id"'),
      reason: 'no case yet binds a token to a service principal of another organization',
    },
  ],
  predicates: [
    {
      name: 'token rows are scoped to the organization',
      locate: ref('t', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: tokenLookupIgnoresForeign.name,
    },
    {
      name: 'the user joins within the token organization',
      locate: ref('u', 'org_id', '"t"\\."org_id"'),
      neutral: ALWAYS,
      caseName: tokenJoinsForeignUser.name,
    },
  ],
};

const EXISTS_COPY =
  'the released check treats an inconsistent reference as unreleased, so the blob stays ineligible whatever this copy says';
const HOSTED_COPY =
  'an inconsistent reference already blocks eligibility through the released check';

interface BlobRef {
  readonly via: 'version' | 'revision';
  readonly versionOrg: string;
  readonly packageOrg: string;
  readonly sourceOrg: string;
  readonly revisionOrg?: string;
}

const OLD = '2020-01-01T00:00:00.000Z';

async function seedBlobRow(seed: Seed, id: string, orgId: string, sha: string): Promise<void> {
  await seed(
    'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable, published_at) VALUES (?, ?, ?, 1, ?, 1, ?)',
    id,
    orgId,
    sha,
    id,
    OLD,
  );
}

async function seedBlobRef(seed: Seed, blobId: string, key: string, ref: BlobRef): Promise<void> {
  await seedSource(seed, `S-${key}`, ref.sourceOrg, 'vcs');
  await seedPackage(seed, `K-${key}`, ref.packageOrg, `S-${key}`, `acme/${key.toLowerCase()}`);
  await seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at)
      VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 'upstream', '{}', ?, 'tombstoned', ?)`,
    `V-${key}`,
    ref.versionOrg,
    `K-${key}`,
    OLD,
    ref.via === 'version' ? blobId : null,
    OLD,
  );
  if (ref.via === 'revision') {
    await seed(
      "INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) VALUES (?, ?, ?, 1, ?, '{}', 'test')",
      `VR-${key}`,
      ref.revisionOrg ?? ref.versionOrg,
      `V-${key}`,
      blobId,
    );
  }
}

const blobsEligibleForRetention: ContractCase = {
  name: 'only blobs of the organization with consistent released references are eligible',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    const orgs = {
      versionOrg: own.orgId,
      packageOrg: own.orgId,
      sourceOrg: own.orgId,
    };
    let counter = 0;
    const blob = async (id: string, orgId: string, refs: Record<string, BlobRef>) => {
      counter += 1;
      await seedBlobRow(seed, id, orgId, String(counter).padStart(64, '0'));
      for (const [key, ref] of Object.entries(refs))
        await seedBlobRef(seed, id, `${id}-${key}`, ref);
    };
    const consistent: BlobRef = { via: 'version', ...orgs };
    const foreignAll = {
      versionOrg: foreign.orgId,
      packageOrg: foreign.orgId,
      sourceOrg: foreign.orgId,
    };
    const via = (kind: BlobRef['via'], changes: Partial<BlobRef> = {}): BlobRef => ({
      ...orgs,
      ...changes,
      via: kind,
    });
    await blob('B-OK', own.orgId, { a: consistent });
    await blob('B-FOREIGN', foreign.orgId, { a: via('version', foreignAll) });
    await blob('B-VERS', own.orgId, { a: consistent, b: via('version', foreignAll) });
    const packageAway = { packageOrg: foreign.orgId, sourceOrg: foreign.orgId };
    const sourceAway = { sourceOrg: foreign.orgId };
    await blob('B-PKG', own.orgId, { a: consistent, b: via('version', packageAway) });
    await blob('B-SRC', own.orgId, { a: consistent, b: via('version', sourceAway) });
    await blob('B-RVER', own.orgId, { a: consistent, b: via('revision', foreignAll) });
    await blob('B-RPKG', own.orgId, { a: consistent, b: via('revision', packageAway) });
    await blob('B-RSRC', own.orgId, { a: consistent, b: via('revision', sourceAway) });
    await blob('B-RREV', own.orgId, {
      a: consistent,
      b: via('revision', { revisionOrg: foreign.orgId }),
    });
    await blob('B-ING', own.orgId, {});
    await blob('B-UP', own.orgId, {});
    const sha = async (id: string) =>
      (
        await context.executor.all<{ sha256: string }>({
          sql: 'SELECT sha256 FROM blob WHERE id = ?',
          params: [id],
        })
      )[0]?.sha256 ?? '';
    await seedSource(seed, 'S-ING', foreign.orgId, 'vcs');
    await seed(
      `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)
        VALUES ('ING1', ?, 'source', ?, 'S-ING', 1, 'o', 1, ?, 'running', ?, ?, ?)`,
      foreign.orgId,
      'a'.repeat(64),
      FUTURE,
      await sha('B-ING'),
      OLD,
      OLD,
    );
    await seedPackage(seed, 'K-UP', foreign.orgId, 'S-ING', 'acme/up');
    await seed(
      `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)
        VALUES (?, 'K-UP', 'composer-p2', ?, ?, ?)`,
      foreign.orgId,
      await sha('B-UP'),
      OLD,
      OLD,
    );
    const condition = blobEligibleCondition(own, 'b');
    const statement: Statement = {
      sql: `SELECT b.id AS id FROM blob b WHERE ${condition.sql}`,
      params: condition.params,
    };
    const rows = await context.executor.all<{ id: string }>(context.mutate(statement));
    expect(rows.map((row) => row.id).sort()).toEqual(['B-ING', 'B-OK', 'B-UP']);
  },
};

const blobEntry: MutationEntry = {
  builder: 'blobEligibleCondition',
  file: 'repositories/blob-references.ts',
  cases: [blobsEligibleForRetention],
  waivers: [
    {
      locate: /bref_ru\.org_id = b\.org_id/,
      reason: 'import run guard; no case yet seeds an import run of another organization',
    },
    {
      locate: /bref_ir\.org_id = bref_ru\.org_id/,
      reason: 'import run guard; no case yet seeds an import reference of another organization',
    },
  ],
  predicates: [
    {
      name: 'the blob is scoped to the organization',
      locate: /(?<=\()b\.org_id = \?/,
      neutral: NOT_NULL,
      caseName: blobsEligibleForRetention.name,
      copies: 1,
    },
    {
      name: 'a reference version joins within the blob organization',
      locate: /bref_v\.org_id = b\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 6,
      waivedCopies: {
        0: EXISTS_COPY,
        1: EXISTS_COPY,
        4: HOSTED_COPY,
        5: HOSTED_COPY,
      },
    },
    {
      name: 'a reference package joins within the version organization',
      locate: /bref_p\.org_id = bref_v\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 6,
      waivedCopies: {
        0: EXISTS_COPY,
        1: EXISTS_COPY,
        4: HOSTED_COPY,
        5: HOSTED_COPY,
      },
    },
    {
      name: 'a reference source joins within the package organization',
      locate: /bref_s\.org_id = bref_p\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 6,
      waivedCopies: {
        0: EXISTS_COPY,
        1: EXISTS_COPY,
        4: HOSTED_COPY,
        5: HOSTED_COPY,
      },
    },
    {
      name: 'a reference revision joins within the version organization',
      locate: /bref_r\.org_id = bref_v\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 3,
      waivedCopies: { 0: EXISTS_COPY, 2: HOSTED_COPY },
    },
    {
      name: 'an ingest session is scoped to the blob organization',
      locate: /bref_ing\.org_id = b\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 1,
    },
    {
      name: 'an upstream state is scoped to the blob organization',
      locate: /bref_up\.org_id = b\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 1,
    },
  ],
};

const REVISION_CLOCK = /max\(\s*unixepoch\('now', 'subsec'\)/;
const ANY_CLOCK_READ =
  /(?:strftime\('[^']*', 'now'(?:, '[^']*')?\)|unixepoch\('now'(?:, '[^']*')?\))/;
const WRITE_GUARD = { id: A_JOB, owner: OWNER, fence: 3 } as const;
const WRITE_ORG = { orgId: '01J00000000000000000000A0A' } as OrgContext;

const npmVersions = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    version: `1.0.${String(index)}`,
    versionNormalized: `1.0.${String(index)}`,
    history: { at: '2020-05-06T07:08:09.010Z', basis: 'release_date' as const },
    license: null,
    upstreamReleasedAt: null,
    distType: null,
    sourceRef: null,
    metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
  }));

function clockChecks(
  label: string,
  build: (count: number) => readonly Statement[],
  reads: (count: number) => number,
): readonly DecisionCheck[] {
  return [1, 3].flatMap((count) => [
    {
      name: `${label} reads the revision clock once for ${String(count)} versions`,
      pattern: REVISION_CLOCK,
      expected: 1,
      build: () => build(count),
    },
    {
      name: `${label} makes ${String(reads(count))} clock reads for ${String(count)} versions`,
      pattern: ANY_CLOCK_READ,
      expected: reads(count),
      build: () => build(count),
    },
  ]);
}

const writeGuard = () => createCatalogueWriteGuard(WRITE_ORG, WRITE_GUARD);

const packageUpsertEntry: MutationEntry = {
  builder: 'packageUpsertStatements',
  file: 'repositories/catalogue-write-package.ts',
  cases: [],
  predicates: [],
  decisions: [
    {
      name: 'a package upsert reads the clock once',
      pattern: ANY_CLOCK_READ,
      expected: 1,
      build: () =>
        packageUpsertStatements(WRITE_ORG, writeGuard(), {
          sourceId: 'S1',
          ecosystem: 'npm',
          key: 'widget',
          description: null,
        }).statements,
    },
  ],
};

const versionInsertEntry: MutationEntry = {
  builder: 'versionInsertStatements',
  file: 'repositories/catalogue-write-version-insert.ts',
  cases: [],
  predicates: [],
  decisions: clockChecks(
    'a version insert',
    (count) =>
      versionInsertStatements(WRITE_ORG, writeGuard(), {
        packageId: 'K1',
        ecosystem: 'npm',
        versions: npmVersions(count),
      }).statements,
    (count) => count + 2,
  ),
};

const versionUpdateEntry: MutationEntry = {
  builder: 'versionUpdateStatements',
  file: 'repositories/catalogue-write-version-update.ts',
  cases: [],
  predicates: [],
  decisions: clockChecks(
    'a version update',
    (count) =>
      versionUpdateStatements(WRITE_ORG, writeGuard(), {
        packageId: 'K1',
        ecosystem: 'npm',
        versions: npmVersions(count),
      }).statements,
    (count) => count + 1,
  ),
};

const GROUP_BRANCH = 'group membership branch; no case seeds memberships yet';
const SESSION_GATE = 'redundant with the session check of the same guard, which fails first';
const SELECT_ORG = '\\(select "guard_values"\\."org_id" from "guard_values"\\)';

const permissionRowsEntry: MutationEntry = {
  builder: 'permissionRows',
  file: 'repositories/access.ts',
  cases: LAYERS.map(rowsCase),
  waivers: [
    {
      locate: /"guard_user"\."org_id" = "guard_member"\."org_id"/,
      reason: GROUP_BRANCH,
    },
    {
      locate: /"guard_grant"\."org_id" = "guard_member"\."org_id"/,
      reason: GROUP_BRANCH,
    },
    { locate: /"guard_member"\."org_id" = \(select/, reason: GROUP_BRANCH },
  ],
  predicates: [
    {
      name: 'the user is scoped to the organization',
      locate: ref('guard_user', 'org_id', SELECT_ORG),
      neutral: ALWAYS,
      caseName: rowsCase('user').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the grant joins within the user organization',
      locate: ref('guard_grant', 'org_id', '"guard_user"\\."org_id"'),
      neutral: ALWAYS,
      caseName: rowsCase('grant').name,
    },
    {
      name: 'the role joins within the grant organization',
      locate: ref('guard_role', 'org_id', '"guard_grant"\\."org_id"'),
      neutral: ALWAYS,
      caseName: rowsCase('role').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the permission joins within the role organization',
      locate: ref('guard_perm', 'org_id', '"guard_role"\\."org_id"'),
      neutral: ALWAYS,
      caseName: rowsCase('permission').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the identity is scoped to the organization',
      locate: ref('guard_identity', 'org_id', SELECT_ORG),
      neutral: ALWAYS,
      caseName: rowsCase('identity').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the provider binding is scoped to the organization',
      locate: ref('guard_binding', 'org_id', SELECT_ORG),
      neutral: ALWAYS,
      caseName: rowsCase('binding').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
  ],
};

const permissionRowsWaiver: OrgWaiver = {
  locate: /"guard_\w+"\."org_id" = /,
  reason: PERMISSION_ROWS,
};

const holdsPermissionEntry: MutationEntry = {
  builder: 'holdsPermission',
  file: 'repositories/access.ts',
  cases: [holdsForeignProject],
  waivers: [permissionRowsWaiver],
  predicates: [
    {
      name: 'the project is scoped to the organization',
      locate: ref('hp_project', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: holdsForeignProject.name,
    },
  ],
};

const actorHoldsEntry: MutationEntry = {
  builder: 'actorHolds',
  file: 'repositories/actor-authority.ts',
  cases: [actorSessionIdentityOfForeignOrg, actorArchivedForeignProject],
  waivers: [
    permissionRowsWaiver,
    {
      locate: ref('actor', 'org_id', '"s"\\."org_id"'),
      reason:
        'the actor row must also be the permission user, whom permissionRows scopes by organization',
    },
    {
      locate: ref('s', 'org_id', '\\?'),
      reason:
        'the actor join and permissionRows both refuse a session of another organization; either alone suffices',
    },
    {
      locate: ref('hp_session', 'org_id', '\\?'),
      reason: 'local-admin eligibility only; no case seeds a local login yet',
    },
  ],
  predicates: [
    {
      name: 'the session identity joins within the session organization',
      locate: ref('i', 'org_id', '"s"\\."org_id"'),
      neutral: ALWAYS,
      caseName: actorSessionIdentityOfForeignOrg.name,
    },
    {
      name: 'the project of an archived-project check is scoped to the organization',
      locate: /(?<=from "project" where )"org_id" = \?/,
      neutral: NOT_NULL,
      caseName: actorArchivedForeignProject.name,
    },
  ],
};

const servicePrincipalGuardEntry: MutationEntry = {
  builder: 'servicePrincipalAuthorityGuard',
  file: 'repositories/service-principal-authority.ts',
  cases: [spCoversForeignPermission],
  waivers: [
    permissionRowsWaiver,
    { locate: ref('s', 'org_id', '\\?'), reason: 'registered under actorHolds' },
    { locate: ref('i', 'org_id', '"s"\\."org_id"'), reason: 'registered under actorHolds' },
    { locate: ref('actor', 'org_id', '"s"\\."org_id"'), reason: 'registered under actorHolds' },
    { locate: ref('hp_session', 'org_id', '\\?'), reason: SESSION_GATE },
    { locate: ref('sa_session', 'org_id', '\\?'), reason: SESSION_GATE },
    {
      locate: /(?<=\(randomblob\(16\)\) where )"org_id" = \?/,
      reason: 'the cache epoch bump of the fence guard, not a scoping predicate of this builder',
    },
  ],
  predicates: [
    {
      name: 'covered permission rows join within the role organization',
      locate: ref('guard_perm', 'org_id', '"guard_role"\\."org_id"'),
      neutral: ALWAYS,
      caseName: spCoversForeignPermission.name,
      waivedCopies: {
        0: 'the actor permission, which the management permission check already decides',
        1: GROUP_BRANCH,
        3: GROUP_BRANCH,
      },
    },
  ],
};

function foreignGroupEvidenceCase(part: 'member' | 'identity' | 'binding'): ContractCase {
  return {
    name: `group evidence with a foreign ${part} does not retain the user`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      const evidenceOrg = (candidate: typeof part) =>
        candidate === part ? foreign.orgId : own.orgId;
      const now = new Date().toISOString();
      await seedUser(seed, 'U-GROUP', own.orgId);
      await seed(
        'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
        evidenceOrg('member'),
        'U-GROUP',
        'oidc',
        'staff',
        now,
      );
      await seed(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        'I-GROUP',
        evidenceOrg('identity'),
        'U-GROUP',
        'oidc',
        'subject',
        'u-group@example.test',
        now,
      );
      await seed(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        evidenceOrg('binding'),
        'oidc',
        'current-anchor',
      );
      const alias = guardAliases(
        [
          'user',
          'grant',
          'role',
          'member',
          'identity',
          'binding',
          'login',
          'credential',
          'values',
          'anchors',
        ],
        null,
      );
      const bindings = guardBindings(
        { values: alias.values, anchors: alias.anchors },
        { org_id: own.orgId },
        [{ provider: 'oidc', anchor: 'current-anchor', emailAuthoritative: true }],
      );
      const rows = await context.executor.all(
        context.mutate(
          compile(
            bindings.creator
              .selectFrom(`user_group as ${alias.member}`)
              .innerJoin(
                `user_account as ${alias.user}`,
                `${alias.user}.id`,
                `${alias.member}.user_id`,
              )
              .select(`${alias.user}.id`)
              .where(freshGroupMembership(bindings, alias)),
          ),
        ),
      );
      expect(rows).toEqual([]);
    },
  };
}

const freshGroupMembershipEntry: MutationEntry = {
  builder: 'freshGroupMembership',
  file: 'kysely.ts',
  cases: (['member', 'identity', 'binding'] as const).map((part) => foreignGroupEvidenceCase(part)),
  predicates: (['member', 'identity', 'binding'] as const).map((part) => ({
    name: `the ${part} evidence is scoped to the organization`,
    locate: ref(`guard_${part}`, 'org_id', SELECT_ORG),
    neutral: ALWAYS,
    copies: 1,
    caseName: foreignGroupEvidenceCase(part).name,
  })),
};

export const mutationTable: readonly MutationEntry[] = [
  freshGroupMembershipEntry,
  {
    builder: 'proxyEligibleCondition',
    file: 'repositories/catalogue-predicates.ts',
    waivers: [
      {
        locate: ref('pkg', 'org_id', '\\?'),
        reason: 'restricts the rows of the test query, not part of the builder',
      },
    ],
    cases: [proxyShadowedByForeignPackage, proxyBlockedByForeignName],
    predicates: [
      {
        name: 'proxy shadow check is scoped to the package organization',
        locate: ref('guard_q', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyShadowedByForeignPackage.name,
      },
      {
        name: 'registered name check is scoped to the package organization',
        locate: ref('guard_r', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyBlockedByForeignName.name,
      },
    ],
  },
  {
    builder: 'attachedSourceCondition',
    file: 'repositories/catalogue-predicates.ts',
    cases: [attachedCase('attachment'), attachedCase('source'), attachedCase('project')],
    predicates: [
      {
        name: 'attachment row is scoped to the organization',
        locate: ref('guard_ps', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase('attachment').name,
      },
      {
        name: 'source row is scoped to the organization',
        locate: ref('guard_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase('source').name,
      },
      {
        name: 'project row is scoped to the organization',
        locate: ref('guard_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase('project').name,
      },
    ],
  },
  {
    builder: 'readTimeCondition',
    file: 'repositories/catalogue-predicates.ts',
    cases: [readTimeForeignProject],
    predicates: [
      {
        name: 'project row is scoped to the organization',
        locate: ref('guard_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: readTimeForeignProject.name,
      },
    ],
  },
  {
    builder: 'coveredByRegisteredNames',
    file: 'repositories/registered-name.ts',
    cases: [coveredByForeignName],
    predicates: [
      {
        name: 'registered name row is scoped to the organization',
        locate: ref('rn_cov', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: coveredByForeignName.name,
      },
    ],
  },
  {
    builder: 'sourceActivatable',
    file: 'repositories/registered-name.ts',
    waivers: [
      {
        locate: ref('rn_act_c', 'org_id', 'rn_act_s\\.org_id'),
        reason: 'scope completeness of npm registries; no case yet reaches it',
      },
    ],
    cases: [activatableCase('source'), activatableCase('name')],
    predicates: [
      {
        name: 'source row is scoped to the organization',
        locate: ref('rn_act_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: activatableCase('source').name,
      },
      {
        name: 'registered name rows match the source organization',
        locate: ref('rn_act_r', 'org_id', 'rn_act_s\\.org_id'),
        neutral: ALWAYS,
        caseName: activatableCase('name').name,
      },
    ],
  },
  {
    builder: 'distTagStatements',
    file: 'repositories/catalogue-write-tags.ts',
    waivers: [
      {
        locate: /\bjob\.org_id = \?/,
        reason: 'the lease guard statement, owned by jobLeaseGuard (allowlisted)',
      },
    ],
    cases: [tagOnForeignPackage, tagToForeignVersion, tagRemovalSpares],
    decisions: [revisionClockCheck(1), revisionClockCheck(3)],
    predicates: [
      {
        name: 'package rows are scoped to the organization',
        locate: ref('package', 'org_id', '\\?'),
        neutral: NOT_NULL,
        waivedCopies: {
          1: 'the revision advance of a package of another organization is unreachable: the head check above it already aborts the batch',
        },
        caseName: tagOnForeignPackage.name,
      },
      {
        name: 'version rows are scoped to the organization',
        locate: ref('version', 'org_id', '\\?'),
        neutral: NOT_NULL,
        waivedCopies: {
          0: OWN_TARGET,
          2: ABORTED_BY_CHECK,
          3: ABORTED_BY_CHECK,
          4: ABORTED_BY_CHECK,
          5: ABORTED_BY_CHECK,
        },
        caseName: tagToForeignVersion.name,
      },
      {
        name: 'removed dist tag rows are scoped to the organization',
        locate: ref('dist_tag', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: tagRemovalSpares.name,
      },
    ],
  },
  {
    builder: 'revokeAllForUserStatement',
    file: 'repositories/session.ts',
    cases: [revokeSparesForeignSessions],
    predicates: [
      {
        name: 'session rows are scoped to the organization',
        locate: ref('session', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: revokeSparesForeignSessions.name,
      },
    ],
  },
  {
    builder: 'sessionInsertStatement',
    file: 'repositories/session.ts',
    cases: [sessionNotMintedForForeignUser],
    predicates: [
      {
        name: 'the user row is scoped to the organization',
        locate: ref('user_account', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: sessionNotMintedForForeignUser.name,
      },
    ],
  },
  lookupSessionEntry,
  lookupTokenEntry,
  permissionRowsEntry,
  holdsPermissionEntry,
  actorHoldsEntry,
  servicePrincipalGuardEntry,
  blobEntry,
  packageUpsertEntry,
  versionInsertEntry,
  versionUpdateEntry,
  {
    builder: 'epochReadStatement',
    file: 'repositories/cache-epoch.ts',
    cases: [epochReadSparesForeign],
    predicates: [
      {
        name: 'epoch rows are scoped to the organization',
        locate: ref('cache_epoch', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: epochReadSparesForeign.name,
      },
    ],
  },
  {
    builder: 'dueStatement',
    file: 'repositories/source.ts',
    cases: [dueSparesForeignSources],
    predicates: [
      {
        name: 'source rows are scoped to the organization',
        locate: /(?<=from "source" where )"org_id" = \?/,
        copies: 1,
        neutral: NOT_NULL,
        caseName: dueSparesForeignSources.name,
      },
    ],
  },
];

const NO_ORG_COLUMN = 'builds no organization-scoped read or write';
const UNREGISTERED = 'organization scoping not yet registered in the mutation table';

/** Exported builders that are not in `mutationTable`, each with the reason. */
export const builderAllowlist: Readonly<Record<string, string>> = {
  'internal/lease-time.ts#until':
    'builds only a lease timestamp expression; no organization-scoped read or write',
  'repositories/catalogue-write-dist.ts#distAttachStatements':
    'blob, version and package org predicates have catalogue-write-dist contract coverage; mutation cases not yet registered',
  'repositories/ingest-session.ts#ingestSessionGuard':
    'session holder org predicate has ingest-session contract coverage; mutation case not yet registered',
  'repositories/ingest-session.ts#sweepStatements':
    'global maintenance intentionally spans orgs; same-org generation comparison has ingest-session-latest contract coverage but no mutation case yet',
  'repositories/blob-lease-guard.ts#blobLeaseNotLive': UNREGISTERED,
  'repositories/catalogue-predicates.ts#admissionCondition':
    'admission pattern rules carry no organization column; their scoping is project and source ids, which T716 registers',
  'repositories/catalogue-predicates.ts#winnerOrder': NO_ORG_COLUMN,
  'repositories/catalogue-read.ts#visibleWinner': UNREGISTERED,
  'repositories/catalogue-status.ts#quarantineStatements': UNREGISTERED,
  'repositories/fetch-lease.ts#fetchLeaseGuard': UNREGISTERED,
  'repositories/job-lease-guard.ts#jobLeaseGuard': UNREGISTERED,
  'repositories/project-readable.ts#listReadableProjectsStatement': UNREGISTERED,
  'repositories/proxy-admission.ts#admittedProxySources': UNREGISTERED,
  'repositories/role.ts#seedDefaultsStatements': UNREGISTERED,
  'repositories/session-liveness.ts#liveSessionCondition': NO_ORG_COLUMN,
  'repositories/session.ts#revokePreviousStatement': UNREGISTERED,
  'repositories/visibility-attach.ts#attachSourceStatements': UNREGISTERED,
  'repositories/visibility-derive.ts#rederiveStatements': UNREGISTERED,
  'repositories/cache-epoch-bump.ts#cacheEpochBumpStatements': UNREGISTERED,
  'kysely.ts#compile': NO_ORG_COLUMN,
  'kysely.ts#existsGuard': UNREGISTERED,
  'kysely.ts#opGuard': UNREGISTERED,
  'kysely.ts#ownsIdentity': UNREGISTERED,
  'kysely.ts#anchorMatches': UNREGISTERED,
  'kysely.ts#adminEligibility': UNREGISTERED,
  'kysely.ts#usableLocalLogin': UNREGISTERED,
  'kysely.ts#verifiedIdentity': UNREGISTERED,
  'kysely.ts#boundVerifiedIdentity': UNREGISTERED,
  'kysely.ts#protectedHolder': UNREGISTERED,
  'kysely.ts#assertCheck': NO_ORG_COLUMN,
  'kysely.ts#cacheEpochBumpStatements': UNREGISTERED,
  'kysely.ts#assertGuard': UNREGISTERED,
  'internal/catalogue-status-statements.ts#versionStatusStatements': UNREGISTERED,
  'internal/catalogue-status-statements.ts#conditionalEpochBumpStatement': UNREGISTERED,
  'internal/catalogue-write-guard.ts#registerCatalogueWriteGuard': NO_ORG_COLUMN,
  'internal/catalogue-write-guard.ts#assertCatalogueWriteGuard': NO_ORG_COLUMN,
};

/** Problems between the exported builders of the given repository sources, the table and the allowlist. */
export function checkCompleteness(
  sources: Readonly<Record<string, string>>,
  table: readonly MutationEntry[] = mutationTable,
  allowlist: Readonly<Record<string, string>> = builderAllowlist,
): string[] {
  const exported = new Set<string>();
  for (const file of Object.keys(sources)) {
    for (const name of builderNames(file, sources)) exported.add(`${file}#${name}`);
  }
  const registered = new Set(table.map((entry) => `${entry.file}#${entry.builder}`));
  const problems: string[] = [];
  for (const key of exported) {
    if (!registered.has(key) && !(key in allowlist)) problems.push(`${key} has no registration`);
  }
  for (const key of registered) {
    if (!exported.has(key)) problems.push(`${key} is registered but no longer exported`);
  }
  for (const key of Object.keys(allowlist)) {
    if (!exported.has(key)) problems.push(`${key} is allowlisted but no longer exported`);
    if (registered.has(key)) problems.push(`${key} is allowlisted and registered`);
  }
  return problems;
}
