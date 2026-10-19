import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import {
  describeCatalogueRaceContract,
  runCatalogueRaceCase,
  type Order,
  type OpenedCatalogueRaceDatabase,
} from './catalogue-race-contract.js';

async function openFile(): Promise<OpenedCatalogueRaceDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-catalogue-race-'));
  const database = await openMigratedDatabase({
    file: join(directory, 'race.sqlite'),
    d1PatternLimit: true,
  });
  return {
    executor: database.executor,
    second: () => database.second(),
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describeCatalogueRaceContract('node:sqlite', openFile);

for (const order of ['first-then-second', 'second-then-first'] as const) {
  it(`restores through the gated executor (${order})`, async () => {
    const completed: string[] = [];
    await runCatalogueRaceCase(openFile, 'projectRestoreVsDiscovery', order, (executor) => ({
      ...executor,
      async batch(statements) {
        const result = await executor.batch(statements);
        if (statements.some((s) => s.sql.startsWith("UPDATE project SET status = 'active'"))) {
          completed.push('restore');
        }
        if (
          statements.some(
            (s) => /^insert into "package" /i.test(s.sql) && s.params.includes('fresh'),
          )
        ) {
          completed.push('discovery');
        }
        return result;
      },
    }));
    expect(completed).toEqual(
      order === 'first-then-second' ? ['restore', 'discovery'] : ['discovery', 'restore'],
    );
  });
}

const NOOP: Statement = { sql: 'SELECT 1', params: [] };
const derivedWrite = (sql: string) =>
  /^(insert or ignore into|delete from|update) "project_package" /i.test(sql);

interface Mutation {
  readonly name: string;
  readonly case: string;
  readonly order: Order;
  readonly applies: (batch: readonly Statement[], statement: Statement) => boolean;
  readonly change?: (statement: Statement) => Statement;
  readonly mismatch?: { readonly actual: readonly string[]; readonly expected: readonly string[] };
}

const mutations: readonly Mutation[] = [
  {
    name: 'creation rederive removed',
    case: 'attachVsDiscovery',
    order: 'first-then-second',
    applies: (batch, s) =>
      derivedWrite(s.sql) && batch.some((o) => /^insert into "package" /i.test(o.sql)),
  },
  {
    name: 'pattern rederive removed',
    case: 'patternAddVsDiscovery',
    order: 'first-then-second',
    applies: (batch, s) =>
      derivedWrite(s.sql) &&
      batch.some((o) => /^insert into "project_package_pattern" /i.test(o.sql)),
  },
  {
    name: 'flag rederive removed',
    case: 'flagFlipVsDiscovery',
    order: 'first-then-second',
    applies: (batch, s) =>
      derivedWrite(s.sql) &&
      batch.some((o) => /^update "package" set "visible_to_new_projects"/i.test(o.sql)),
  },
  {
    name: 'creation rederive removed under restore',
    case: 'projectRestoreVsDiscovery',
    order: 'first-then-second',
    applies: (batch, s) =>
      derivedWrite(s.sql) &&
      batch.some((o) => /^insert into "package" /i.test(o.sql) && o.params.includes('fresh')),
    mismatch: {
      actual: ['project:archived-fresh:subscription', 'project:widget:subscription'],
      expected: [
        'project:archived-fresh:subscription',
        'project:fresh:subscription',
        'project:widget:subscription',
      ],
    },
  },
  {
    name: 'detach keeps the attachment',
    case: 'detachBetweenPages',
    order: 'second-then-first',
    applies: (_batch, s) => /^delete from "project_source" /i.test(s.sql),
  },
  {
    name: 'job lease check removed',
    case: 'staleJobAfterTakeover',
    order: 'second-then-first',
    applies: (_batch, s) => s.sql.startsWith('with "guard_cond"') && s.sql.includes('lease_owner'),
  },
  {
    name: 'package creation does not tolerate a concurrent creator',
    case: 'twoSyncsOfOnePackage',
    order: 'second-then-first',
    applies: (_batch, s) => /^insert into "package" /i.test(s.sql),
    change: (s) => ({ ...s, sql: s.sql.replace(/on conflict\s*\([^)]*\)\s*do nothing/i, '') }),
  },
  {
    name: 'dist attach revision check removed',
    case: 'quarantineVsDistAttach',
    order: 'first-then-second',
    applies: (_batch, s) =>
      s.sql.startsWith('with "guard_cond"') && s.sql.includes('version.blob_id'),
  },
  {
    name: 'finalize sweeps every version',
    case: 'reconcileFinalizeVsVersionInsert',
    order: 'second-then-first',
    applies: (_batch, s) => /^update "?version"? set status = 'removed_upstream'/i.test(s.sql),
    change: (s) => ({
      ...s,
      sql: s.sql.replace(/version\.updated_at\s*</g, '1 = 1 OR version.updated_at <'),
    }),
  },
];

for (const mutation of mutations) {
  it(`detects ${mutation.name} (${mutation.case}, ${mutation.order})`, async () => {
    let changed = 0;
    const weaken = (executor: SqlExecutor): SqlExecutor => ({
      ...executor,
      batch(statements) {
        return executor.batch(
          statements.map((statement) => {
            if (!mutation.applies(statements, statement)) return statement;
            changed += 1;
            return mutation.change?.(statement) ?? NOOP;
          }),
        );
      },
    });
    const run = runCatalogueRaceCase(openFile, mutation.case, mutation.order, weaken);
    if (mutation.mismatch) {
      await expect(run).rejects.toMatchObject(mutation.mismatch);
    } else {
      await expect(run).rejects.toThrow();
    }
    expect(changed).toBeGreaterThan(0);
  });
}
