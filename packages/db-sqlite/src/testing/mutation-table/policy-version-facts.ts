import { expect } from 'vitest';
import { createPolicyVersionFactsReader } from '../../repositories/policy-version-facts.js';
import { executing } from './factory-cases.js';
import { NOT_NULL, seedPackage, seedSource, seedVersion } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const foreignVersion: ContractCase = {
  name: 'policy version facts exclude a foreign version under an own package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seedVersion(seed, 'V1', own.orgId, 'K', '1.0.0');
    await seedVersion(seed.forged, 'V2', foreign.orgId, 'K', '2.0.0');
    const rows = await createPolicyVersionFactsReader(executing(context)).versionFacts(own, {
      packageId: 'K',
      limit: 10,
    });
    expect(rows.map((row) => row.versionId)).toEqual(['V1']);
  },
};

const foreignPackage: ContractCase = {
  name: 'policy version facts exclude an own version under a foreign package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'hosted', 'npm');
    await seedPackage(seed, 'K', foreign.orgId, 'S', 'foreign-name', 'npm');
    await seedVersion(seed.forged, 'V1', own.orgId, 'K', '1.0.0');
    expect(
      await createPolicyVersionFactsReader(executing(context)).versionFacts(own, {
        packageId: 'K',
        versionIds: ['V1'],
        limit: 10,
      }),
    ).toEqual([]);
  },
};

const foreignHold: ContractCase = {
  name: 'policy version facts ignore a foreign publish hold on an own version',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seedVersion(seed, 'V1', own.orgId, 'K', '1.0.0');
    await seed("UPDATE version SET status='quarantined' WHERE org_id=? AND id='V1'", own.orgId);
    await seed.forged(
      `INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,expires_at)
      VALUES ('approval',?,'K','V1','S',1,0,'pending','not_required','service','principal','token','2099-01-01T00:00:00.000Z')`,
      foreign.orgId,
    );
    const rows = await createPolicyVersionFactsReader(executing(context)).versionFacts(own, {
      packageId: 'K',
      limit: 10,
    });
    expect(rows.map((row) => [row.versionId, row.status])).toEqual([['V1', 'quarantined']]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/policy-version-facts.ts',
    builder: 'createPolicyVersionFactsReader',
    cases: [foreignVersion, foreignPackage, foreignHold],
    predicates: [
      {
        name: 'versions belong to the organization',
        locate: /\bv\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignVersion.name,
      },
      {
        name: 'the package belongs to the organization',
        locate: /\bpkg\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPackage.name,
      },
      {
        name: 'a publish hold belongs to the organization',
        locate: /\bpa\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignHold.name,
      },
    ],
    waivers: [],
  },
];
