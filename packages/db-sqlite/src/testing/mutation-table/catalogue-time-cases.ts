import { expect } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { Statement } from '@package-broker/core/db/port';
import {
  createCatalogueWriteGuard,
  packageUpsertStatements,
} from '../../repositories/catalogue-write-package.js';
import { versionInsertStatements } from '../../repositories/catalogue-write-version-insert.js';
import { versionUpdateStatements } from '../../repositories/catalogue-write-version-update.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type SqlDecisionCheck,
} from './harness.js';
import {
  A_JOB,
  OWNER,
  FUTURE,
  npmVersions,
  seedPackage,
  seedSource,
  WRITE_GUARD,
} from './fixtures.js';

type Kind = 'upsert' | 'insert' | 'update';
type Scenario = 'future' | 'past' | 'unchanged';
const PAST = '2000-01-01T00:00:00.000Z';

async function fixture(
  context: CaseContext,
  ecosystem: 'npm' | 'composer' = 'npm',
): Promise<CatalogueWriteGuard> {
  const { own } = orgOf(context);
  const seed = seeder(context.executor);
  await seed(
    "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES (?, ?, 'sync:v1', 'time-case', 'running', ?, ?, 3)",
    A_JOB,
    own.orgId,
    OWNER,
    FUTURE,
  );
  await seedSource(
    seed,
    'S',
    own.orgId,
    ecosystem === 'npm' ? 'npm_registry' : 'composer_repository',
    ecosystem,
  );
  await seedPackage(
    seed,
    'K',
    own.orgId,
    'S',
    ecosystem === 'npm' ? 'widget' : 'acme/widget',
    ecosystem,
  );
  return createCatalogueWriteGuard(own, WRITE_GUARD);
}

async function clock(context: CaseContext): Promise<string> {
  const rows = await context.executor.all<{ stamp: string }>({
    sql: "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS stamp",
    params: [],
  });
  return rows[0]!.stamp;
}

export function writeTimeCase(
  kind: Kind,
  scenario: Scenario,
  ecosystem: 'npm' | 'composer' = 'npm',
): ContractCase {
  return {
    name: `${ecosystem} ${kind} ${scenario === 'unchanged' ? 'leaves the revision and time unchanged for a no-op batch' : `advances revision once and chooses ${scenario === 'future' ? 'the previous time plus one millisecond' : 'database time'} for a batch`}`,
    async run(context) {
      const { own } = orgOf(context);
      const guard = await fixture(context, ecosystem);
      const versions = npmVersions(3).map((input) =>
        ecosystem === 'npm'
          ? input
          : {
              ...input,
              versionNormalized: `${input.version}.0`,
              metadata: normalizeVersionMetadata('composer', { name: 'acme/widget' }),
            },
      );
      if (kind === 'update' || (kind === 'insert' && scenario === 'unchanged')) {
        await context.executor.batch(
          versionInsertStatements(own, guard, { packageId: 'K', ecosystem, versions }).statements,
        );
      }
      const initial = scenario === 'past' ? PAST : FUTURE;
      await seeder(context.executor)(
        "UPDATE package SET rev = 7, modified_at = ? WHERE id = 'K'",
        initial,
      );
      let statements: readonly Statement[];
      if (kind === 'upsert')
        statements = packageUpsertStatements(own, guard, {
          sourceId: 'S',
          ecosystem: 'npm',
          key: 'widget',
          description: scenario === 'unchanged' ? null : 'changed',
        }).statements;
      else if (kind === 'insert')
        statements = versionInsertStatements(own, guard, {
          packageId: 'K',
          ecosystem,
          versions,
        }).statements;
      else
        statements = versionUpdateStatements(own, guard, {
          packageId: 'K',
          ecosystem,
          versions:
            scenario === 'unchanged'
              ? versions
              : versions.map((input) => ({
                  ...input,
                  ...(ecosystem === 'composer' ? { license: 'MIT' } : {}),
                  metadata: { ...input.metadata, deprecatedMessage: 'Use 2' },
                })),
        }).statements;
      const before = await clock(context);
      // Execute directly: result-array length checks cannot count as behavioral mutation kills.
      await context.executor.batch(context.mutateBatch(statements));
      const after = await clock(context);
      const rows = await context.executor.all<{ rev: number; modified_at: string }>({
        sql: "SELECT rev, modified_at FROM package WHERE id = 'K'",
        params: [],
      });
      expect(rows[0]?.rev).toBe(scenario === 'unchanged' ? 7 : 8);
      if (scenario === 'past') {
        expect(rows[0]!.modified_at >= before).toBe(true);
        expect(rows[0]!.modified_at <= after).toBe(true);
      } else
        expect(rows[0]?.modified_at).toBe(
          scenario === 'unchanged' ? FUTURE : '2099-01-01T00:00:00.001Z',
        );
      if (kind === 'update' && ecosystem === 'composer') {
        const revisions = await context.executor.all({
          sql: "SELECT revision FROM version_revision WHERE version_id IN (SELECT id FROM version WHERE package_id = 'K') ORDER BY version_id",
          params: [],
        });
        expect(revisions).toEqual(
          scenario === 'unchanged' ? [] : [{ revision: 1 }, { revision: 1 }, { revision: 1 }],
        );
      }
      if (kind !== 'upsert') {
        const stored = await context.executor.all<{
          published_at: string;
          deprecated_message: string | null;
        }>({
          sql: "SELECT published_at, deprecated_message FROM version WHERE package_id = 'K' ORDER BY version_normalized",
          params: [],
        });
        expect(stored).toHaveLength(3);
        expect(stored.map(({ published_at }) => published_at)).toEqual(
          versions.map(({ history }) => history.at),
        );
        expect(stored.map(({ deprecated_message }) => deprecated_message)).toEqual(
          versions.map(() => (kind === 'update' && scenario !== 'unchanged' ? 'Use 2' : null)),
        );
      } else {
        expect(
          await context.executor.all({
            sql: "SELECT description FROM package WHERE id = 'K'",
            params: [],
          }),
        ).toEqual([{ description: scenario === 'unchanged' ? null : 'changed' }]);
      }
    },
  };
}

export function monotonicDecisions(
  kind: Kind,
  ecosystem: 'npm' | 'composer' = 'npm',
): readonly SqlDecisionCheck[] {
  return (['future', 'past'] as const).map((scenario) => ({
    name: `chooses the later of database time and the previous time plus one millisecond (${ecosystem}, ${scenario})`,
    pattern: /max\(\s*unixepoch\('now', 'subsec'\)/,
    replacement: "min(unixepoch('now', 'subsec')",
    expected: 1,
    case: writeTimeCase(kind, scenario, ecosystem),
  }));
}

export function publicationCase(synced: boolean): ContractCase {
  return {
    name: `version insert chooses ${synced ? 'broker time after synchronization' : 'upstream history before synchronization'} for every version`,
    async run(context) {
      const { own } = orgOf(context);
      const guard = await fixture(context);
      if (synced)
        await seeder(context.executor)(
          "UPDATE package SET last_synced_at = '2021-01-01T00:00:00.000Z' WHERE id = 'K'",
        );
      const versions = npmVersions(3).map((input, index) => ({
        ...input,
        history: { ...input.history, at: `2020-05-0${String(index + 1)}T07:08:09.010Z` },
      }));
      const plan = versionInsertStatements(own, guard, {
        packageId: 'K',
        ecosystem: 'npm',
        versions,
      });
      const before = await clock(context);
      await context.executor.batch(context.mutateBatch(plan.statements));
      const after = await clock(context);
      const rows = await context.executor.all<{ published_at: string; published_at_basis: string }>(
        {
          sql: "SELECT published_at, published_at_basis FROM version WHERE package_id = 'K' ORDER BY version_normalized",
          params: [],
        },
      );
      expect(rows).toHaveLength(3);
      rows.forEach((row, index) => {
        expect(row.published_at_basis).toBe(synced ? 'broker' : 'release_date');
        if (synced) {
          expect(row.published_at >= before).toBe(true);
          expect(row.published_at <= after).toBe(true);
        } else expect(row.published_at).toBe(versions[index]!.history.at);
      });
    },
  };
}

export const futureHistoryCase: ContractCase = {
  name: 'version insert refuses future history before synchronization without changing rows',
  async run(context) {
    const { own } = orgOf(context);
    const guard = await fixture(context);
    const versions = npmVersions(3).map((input) => ({
      ...input,
      history: { ...input.history, at: FUTURE },
    }));
    const plan = versionInsertStatements(own, guard, {
      packageId: 'K',
      ecosystem: 'npm',
      versions,
    });
    await expect(context.executor.batch(context.mutateBatch(plan.statements))).rejects.toThrow(
      ACCESS_MUTATION_GUARD_CONSTRAINT,
    );
    expect(
      await context.executor.all({
        sql: "SELECT id FROM version WHERE package_id = 'K'",
        params: [],
      }),
    ).toEqual([]);
    expect(
      await context.executor.all({ sql: "SELECT rev FROM package WHERE id = 'K'", params: [] }),
    ).toEqual([{ rev: 1 }]);
  },
};
