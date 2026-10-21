import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { TwoOrganizations } from '../../contract/two-organizations.js';
import { openMigratedDatabase } from '../migrated-database.js';
import { withForeignKeysOff } from '../foreign-keys-off.js';

export interface CaseContext {
  readonly executor: SqlExecutor;
  readonly orgs: TwoOrganizations;
  /** Every statement a case executes goes through here, so the mutation reaches the SQL that runs. */
  mutate<S extends Statement>(statement: S): S;
  mutateBatch(statements: readonly Statement[]): readonly Statement[];
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

export interface BatchDecisionCheck {
  readonly name: string;
  readonly pattern: RegExp;
  readonly expected: number;
  readonly caseName: string;
  /** A time-only case can be kept separate from the entry's organization cases. */
  readonly case?: ContractCase;
}

/** An executable time decision, mutated in the SQL that reaches SQLite. */
export interface SqlDecisionCheck {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly expected: number;
  readonly case: ContractCase;
}

export interface MutationEntry {
  readonly builder: string;
  readonly file: string;
  readonly predicates: readonly OrgPredicate[];
  readonly cases: readonly ContractCase[];
  readonly waivers?: readonly OrgWaiver[];
  readonly decisions?: readonly DecisionCheck[];
  readonly batchDecisions?: readonly BatchDecisionCheck[];
  readonly sqlDecisions?: readonly SqlDecisionCheck[];
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

async function runCase(
  contractCase: ContractCase,
  mutate: Mutator,
  mutateBatch: (statements: readonly Statement[]) => readonly Statement[] = (statements) =>
    statements,
  foreignKeys = true,
): Promise<void> {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    if (database.orgs === null) throw new Error('organizations were not seeded');
    const { executor, orgs } = database;
    const run = () =>
      contractCase.run({
        executor,
        orgs,
        mutate,
        mutateBatch: (statements) => mutateBatch(statements.map((statement) => mutate(statement))),
      });
    if (foreignKeys) await run();
    else await withForeignKeysOff(executor, run);
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
  try {
    await runCase(contractCase, (statement) => statement, undefined, false);
  } catch (error) {
    return { verdict: 'baseline-failed', detail: `without foreign keys: ${describeError(error)}` };
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
      await runCase(contractCase, mutate, undefined, false);
    } catch (error) {
      if (isAssertion(error)) continue;
      return { verdict: 'errored', detail: `${label}: ${describeError(error)}` };
    }
    return { verdict: 'vacuous', detail: `${label}: the case passes without it` };
  }
  return { verdict: 'killed', detail: `${String(total)} copies` };
}

export function judgeSqlDecision(check: SqlDecisionCheck): Promise<Judgement> {
  const predicate: OrgPredicate = {
    name: check.name,
    locate: check.pattern,
    neutral: check.replacement,
    copies: check.expected,
    caseName: check.case.name,
  };
  return judge(
    { builder: 'time decision', file: '', cases: [check.case], predicates: [] },
    predicate,
  );
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

export interface Seed {
  (sql: string, ...params: (string | number | null)[]): Promise<void>;
  readonly forged: Seed;
}

export function seeder(executor: SqlExecutor): Seed {
  const insert = async (sql: string, ...params: (string | number | null)[]): Promise<void> => {
    const [result] = await executor.batch([{ sql, params }]);
    if (/^INSERT INTO project_package \(/i.test(sql) && result?.changes !== 1) {
      throw new Error('project_package fixture must change exactly one row');
    }
  };
  const forged = (async (sql: string, ...params: (string | number | null)[]): Promise<void> => {
    await withForeignKeysOff(executor, () => insert(sql, ...params));
  }) as Seed;
  (forged as { forged: Seed }).forged = forged;
  return Object.assign(insert, { forged }) as Seed;
}

export function orgOf(context: CaseContext): {
  readonly own: OrgContext;
  readonly foreign: OrgContext;
} {
  return { own: context.orgs.a, foreign: context.orgs.b };
}

/** Repeats the deciding SQL statement in the executing batch; the named case must observe it. */
export async function judgeBatchDecision(
  entry: MutationEntry,
  check: BatchDecisionCheck,
): Promise<Judgement> {
  const contractCase = check.case ?? entry.cases.find(({ name }) => name === check.caseName);
  if (contractCase !== undefined && contractCase.name !== check.caseName)
    return { verdict: 'errored', detail: 'the decision case name does not match' };
  if (contractCase === undefined)
    return { verdict: 'errored', detail: `no case named ${check.caseName}` };
  let count = 0;
  try {
    await runCase(
      contractCase,
      (statement) => statement,
      (statements) => {
        count += countDecisions({ ...check, build: () => statements }, statements);
        return statements;
      },
    );
  } catch (error) {
    return { verdict: 'baseline-failed', detail: describeError(error) };
  }
  if (count === 0) return { verdict: 'not-reached', detail: 'no deciding statement executed' };
  if (count !== check.expected)
    return {
      verdict: 'errored',
      detail: `matched ${String(count)}, expected ${String(check.expected)}`,
    };
  let planted = false;
  try {
    await runCase(
      contractCase,
      (statement) => statement,
      (statements) =>
        statements.flatMap((statement) => {
          if (
            planted ||
            !new RegExp(check.pattern.source, check.pattern.flags.replace('g', '')).test(
              statement.sql,
            )
          )
            return [statement];
          planted = true;
          return [statement, statement];
        }),
    );
  } catch (error) {
    return { verdict: isAssertion(error) ? 'killed' : 'errored', detail: describeError(error) };
  }
  return { verdict: 'vacuous', detail: 'the case passes after the decision repeats' };
}
