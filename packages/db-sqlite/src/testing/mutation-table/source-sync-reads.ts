import { expect } from 'vitest';
import {
  existingKeysStatement,
  staleHeldKeysStatement,
} from '../../repositories/source-sync-reads.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ALWAYS, FUTURE, NOT_NULL, ref, seedPackage, seedSource } from './fixtures.js';
import { selectionOrgWaivers } from './source-selection.js';

function foreignSource(read: 'existing' | 'stale'): ContractCase {
  return {
    name: `${read} keys exclude packages of a source owned by another organization`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', foreign.orgId, 'npmjs_proxy', 'npm');
      await seedPackage(seed, 'P', foreign.orgId, 'S', 'shared', 'npm');
      const statement =
        read === 'existing'
          ? existingKeysStatement(own, 'S', ['shared'])
          : staleHeldKeysStatement(own, 'S', { after: null, limit: 2 });
      expect(await context.executor.all(context.mutate(statement))).toEqual([]);
    },
  };
}

const existing = foreignSource('existing');
const stale = foreignSource('stale');

const foreignSourceReference: ContractCase = {
  name: 'stale keys exclude an own package referencing a foreign source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'npmjs_proxy', 'npm');
    await seedPackage(seed.forged, 'P', own.orgId, 'S', 'shared', 'npm');
    expect(
      await context.executor.all(
        context.mutate(staleHeldKeysStatement(own, 'S', { after: null, limit: 2 })),
      ),
    ).toEqual([]);
  },
};

const foreignStateReference: ContractCase = {
  name: 'stale keys ignore foreign upstream state referencing an own package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'npmjs_proxy', 'npm');
    await seedPackage(seed, 'P', own.orgId, 'S', 'shared', 'npm');
    await seed.forged(
      `INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until)
       VALUES (?, 'P', 'npm-packument', ?, ?)`,
      foreign.orgId,
      FUTURE,
      FUTURE,
    );
    expect(
      await context.executor.all(
        context.mutate(staleHeldKeysStatement(own, 'S', { after: null, limit: 2 })),
      ),
    ).toEqual([{ name: 'shared' }]);
  },
};

export const allowlist: Readonly<Record<string, string>> = {
  'repositories/source-sync-reads.ts#createSourceSyncReads':
    'NOT_A_MUTATION: read-only factory adds no SQL; chunks names and maps rows from existingKeysStatement, selectedKeysStatement and staleHeldKeysStatement, registered separately in source-sync-reads.ts.',
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/source-sync-reads.ts',
    builder: 'existingKeysStatement',
    cases: [existing],
    predicates: [
      {
        name: 'existing keys are scoped to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: existing.name,
      },
    ],
  },
  {
    file: 'repositories/source-sync-reads.ts',
    builder: 'staleHeldKeysStatement',
    waivers: selectionOrgWaivers,
    cases: [stale, foreignSourceReference, foreignStateReference],
    predicates: [
      {
        name: 'stale held keys are scoped to the organization',
        locate: ref('p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: stale.name,
        waivedCopies: {
          0: 'The composed selection source organization check independently excludes this foreign source; its isolated mutation case tests that check.',
        },
      },
      {
        name: 'stale held keys require the source organization to match',
        locate: ref('s', 'org_id', '"p"\\."org_id"'),
        neutral: ALWAYS,
        copies: 1,
        caseName: foreignSourceReference.name,
        waivedCopies: {
          0: 'The composed selection source organization check independently rejects the foreign source; its isolated mutation case tests that check.',
        },
      },
      {
        name: 'stale held keys require the upstream state organization to match',
        locate: ref('u', 'org_id', '"p"\\."org_id"'),
        neutral: ALWAYS,
        copies: 1,
        caseName: foreignStateReference.name,
      },
    ],
  },
];
