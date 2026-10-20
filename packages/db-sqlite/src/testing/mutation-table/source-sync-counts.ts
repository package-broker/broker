import { expect } from 'vitest';
import { createCatalogueReconciler } from '../../repositories/catalogue-reconcile.js';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { createSourceSyncCounts } from '../../repositories/source-sync-counts.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { FUTURE, NOT_NULL, seedSource } from './fixtures.js';
import { executing } from './factory-cases.js';

const OLD = '2020-01-01T00:00:00.000Z';

async function openedListing(context: CaseContext) {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seed(
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', ?, 3)`,
    own.orgId,
    FUTURE,
  );
  await seedSource(seed, 'S', own.orgId, 'composer_repository');
  for (const [prefix, org] of [
    ['o', own],
    ['f', foreign],
  ] as const) {
    for (const key of ['a', 'b', 'c']) {
      await seed.forged(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES (?, ?, 'S', 'composer', ?, ?)",
        `${prefix}-${key}`,
        org.orgId,
        `${prefix}/${key}`,
        OLD,
      );
    }
  }
  const reconciler = createCatalogueReconciler(context.executor);
  const guard = createCatalogueWriteGuard(own, { id: 'J', owner: 'worker', fence: 3 });
  const { stamp } = await reconciler.openListing(own, guard, { kind: 'source', sourceId: 'S' });
  await reconciler.markListing(own, guard, {
    scope: { kind: 'source', sourceId: 'S' },
    stamp,
    present: ['o/a'],
  });
  await seed(
    'UPDATE package SET listing_seen_stamp = ? WHERE org_id = ? AND id LIKE ?',
    stamp,
    foreign.orgId,
    'f-%',
  );
  return { own, foreign, stamp, counts: createSourceSyncCounts(executing(context)) };
}

const foreignMarked: ContractCase = {
  name: 'source sync marked count excludes foreign packages carrying the same stamp',
  async run(context) {
    const { own, stamp, counts } = await openedListing(context);
    expect(await counts.markedCount(own, 'S', stamp)).toBe(1);
  },
};

const foreignUnseen: ContractCase = {
  name: 'source sync unseen count excludes foreign packages of the same source',
  async run(context) {
    const { own, stamp, counts } = await openedListing(context);
    expect(await counts.unseenExistingCount(own, 'S', stamp)).toBe(2);
  },
};

const foreignListing: ContractCase = {
  name: 'source sync unseen count rejects a listing opened by another organization',
  async run(context) {
    const { foreign, stamp, counts } = await openedListing(context);
    await expect(counts.unseenExistingCount(foreign, 'S', stamp)).rejects.toThrow();
  },
};

const markedPredicate = {
  name: 'marked count includes only own packages',
  locate:
    /package\.org_id = \?(?=\s+AND package\.source_id = \?\s+AND package\.listing_seen_stamp)/,
  neutral: NOT_NULL,
  copies: 1,
  caseName: foreignMarked.name,
};
const unseenPredicate = {
  name: 'unseen count includes only own packages',
  locate: /package\.org_id = \?(?=\s+AND package\.source_id = \?\s+AND package\.updated_at < \()/,
  neutral: NOT_NULL,
  copies: 1,
  caseName: foreignUnseen.name,
};
const openPredicate = {
  name: 'open listing check reads only an own source',
  locate: /(?<=WHERE id = \? AND )org_id = \?(?= AND listing_open_stamp)/,
  neutral: NOT_NULL,
  copies: 1,
  caseName: foreignListing.name,
};
const boundaryPredicate = {
  name: 'sweep boundary reads only an own source',
  locate: /(?<=WHERE id = \? AND )org_id = \?(?=\))/,
  neutral: NOT_NULL,
  copies: 1,
  caseName: foreignListing.name,
  waivedCopies: {
    0: 'The open listing check requires the same globally unique source id to belong to the organization, so the boundary read cannot differ.',
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/source-sync-counts.ts',
    builder: 'markedCountStatement',
    cases: [foreignMarked],
    predicates: [markedPredicate],
  },
  {
    file: 'repositories/source-sync-counts.ts',
    builder: 'unseenExistingCountStatement',
    cases: [foreignUnseen, foreignListing],
    predicates: [unseenPredicate, openPredicate, boundaryPredicate],
  },
  {
    file: 'repositories/source-sync-counts.ts',
    builder: 'createSourceSyncCounts',
    cases: [foreignMarked, foreignUnseen, foreignListing],
    predicates: [markedPredicate, unseenPredicate, openPredicate, boundaryPredicate],
  },
];
