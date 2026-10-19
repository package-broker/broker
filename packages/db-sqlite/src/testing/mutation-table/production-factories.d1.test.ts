import { describe, expect, it } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../migrated-database.js';
import {
  mutationTable,
  stripPredicate,
  type MutationEntry,
  type OrgPredicate,
} from '../mutation-table.js';

interface Prepared {
  bind(...params: unknown[]): Prepared;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
interface Binding {
  prepare(sql: string): Prepared;
  batch(
    statements: Prepared[],
  ): Promise<{ results: Record<string, unknown>[]; meta: { changes: number } }[]>;
}

async function d1Executor(executor: SqlExecutor): Promise<SqlExecutor> {
  const statements = new WeakMap<Prepared, Statement>();
  function statement(prepared: Prepared): Statement {
    const value = statements.get(prepared);
    if (value === undefined) throw new Error('unbound D1 fixture statement');
    return value;
  }
  const binding: Binding = {
    prepare(sql) {
      const prepared: Prepared = {
        bind(...params) {
          statements.set(prepared, { sql, params: params as Statement['params'] });
          return prepared;
        },
        async all() {
          return { results: await executor.all(statement(prepared)) };
        },
      };
      return prepared;
    },
    async batch(prepared) {
      return (await executor.batch(prepared.map(statement))).map((result) => ({
        results: result.rows,
        meta: { changes: result.changes },
      }));
    },
  };
  const module = '@package-broker/runtime-cloudflare/db/d1-executor';
  const { createD1Executor } = (await import(module)) as {
    createD1Executor(binding: Binding): SqlExecutor;
  };
  return createD1Executor(binding);
}

async function run(entry: MutationEntry, predicate: OrgPredicate, strip: boolean): Promise<void> {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  try {
    if (database.orgs === null) throw new Error('missing organizations');
    const contractCase = entry.cases.find(({ name }) => name === predicate.caseName);
    if (contractCase === undefined) throw new Error('missing registered case');
    const executor = await d1Executor(database.executor);
    expect(executor.driver).toBe('d1');
    let seen = 0;
    await contractCase.run({
      executor,
      orgs: database.orgs,
      mutate(statement) {
        const result = stripPredicate(statement, predicate, 0, seen);
        seen += result.matches;
        return (strip ? result.statement : statement) as typeof statement;
      },
      mutateBatch(statements) {
        return statements.map((statement) => this.mutate(statement));
      },
    });
    expect(seen).toBe(predicate.copies ?? 1);
  } finally {
    await database.close();
  }
}

const priority = new Set([
  'createIngestSessions',
  'createUpstreamStateRepository',
  'createSourceRepository',
  'createDistResolver',
]);
describe('production D1 executor factory child isolation with SQLite binding', () => {
  it('includes the four production factories', () => {
    expect(
      new Set(
        mutationTable.filter(({ builder }) => priority.has(builder)).map(({ builder }) => builder),
      ),
    ).toEqual(priority);
  });
  for (const entry of mutationTable.filter(({ builder }) => priority.has(builder))) {
    for (const predicate of entry.predicates) {
      it(`${entry.builder}: ${predicate.name}`, async () => {
        await run(entry, predicate, false);
        await expect(run(entry, predicate, true)).rejects.toMatchObject({ name: 'AssertionError' });
      });
    }
  }
});
