import { expect } from 'vitest';
import { isCompleteListing } from '@package-broker/core/catalogue/version-rules';
import { createFixtureVersionListings } from '../migrated-database.js';
import { executing } from './factory-cases.js';
import { NOT_NULL, seedPackage, seedSource, seedVersion } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const foreignListing: ContractCase = {
  name: 'fixture listing proof refuses marked versions of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    for (const [id, org] of [
      ['own', own],
      ['foreign', foreign],
    ] as const) {
      await seedSource(seed, `S-${id}`, org.orgId, 'npm_registry', 'npm');
      await seedPackage(seed, `P-${id}`, org.orgId, `S-${id}`, 'fixture', 'npm');
      await seedVersion(seed, `V-${id}`, org.orgId, `P-${id}`, '1.0.0');
      await seed(
        'UPDATE version SET listing_seen_stamp = ? WHERE org_id = ? AND id = ?',
        STAMP,
        org.orgId,
        `V-${id}`,
      );
    }
    await seedVersion(seed, 'V-unmarked', own.orgId, 'P-own', '2.0.0');
    const listings = createFixtureVersionListings(context.executor);
    const proof = await listings.complete(own, 'P-own', STAMP);
    expect(isCompleteListing(proof)).toBe(true);
    expect(proof).toMatchObject({ packageId: 'P-own', stamp: STAMP, count: 1 });
    await expect(
      createFixtureVersionListings(executing(context)).complete(own, 'P-foreign', STAMP),
    ).rejects.toThrow('an empty listing cannot be completed');
    await expect(listings.complete(own, 'P-own', '2026-01-02T00:00:00.000Z')).rejects.toThrow(
      'an empty listing cannot be completed',
    );
    await expect(listings.complete(own, 'P-missing', STAMP)).rejects.toThrow(
      'an empty listing cannot be completed',
    );
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'testing/migrated-database.ts',
    builder: 'createFixtureVersionListings',
    cases: [foreignListing],
    predicates: [
      {
        name: 'marked fixture versions belong to the caller organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignListing.name,
      },
    ],
  },
];
