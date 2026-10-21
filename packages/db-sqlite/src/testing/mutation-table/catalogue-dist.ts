import { expect } from 'vitest';
import { createDistResolver } from '../../repositories/catalogue-dist.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH, seedProject, seedSource, seedPackage, seedVersion } from './fixtures.js';
import { visiblePackage, packageQuery } from './catalogue-factory-fixture.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignBlob: ContractCase = {
  name: 'dist resolution excludes a foreign blob child of an own version',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seedVersion(seed, 'V', own.orgId, 'K', '1.0.0');
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
      own.orgId,
    );
    await seed(
      "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'P' AS project_id, 'K' AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
      own.orgId,
    );
    await seed(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('B', ?, ?, 10, 'b')",
      foreign.orgId,
      HASH,
    );
    await seed("UPDATE version SET blob_id = 'B' WHERE id = 'V'");
    const target = await createDistResolver(executing(context)).resolveDist(own, {
      projectId: 'P',
      ecosystem: 'npm',
      key: 'widget',
      by: 'version',
      versionNormalized: '1.0.0',
    });
    expect(target).toMatchObject({ versionId: 'V', blob: null });
  },
};
const foreignVersion: ContractCase = {
  name: 'dist resolution excludes a foreign version child of an own package',
  async run(context) {
    await visiblePackage(context);
    const { own, foreign } = orgOf(context);
    await seeder(context.executor).forged(
      "UPDATE version SET org_id = ? WHERE id = 'V'",
      foreign.orgId,
    );
    expect(
      await createDistResolver(executing(context)).resolveDist(own, {
        ...packageQuery,
        by: 'version',
        versionNormalized: '1.0.0',
      }),
    ).toBeNull();
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('catalogue-dist', 'createDistResolver', foreignBlob, /b\.org_id = \?/, [
    {
      locate: /"?guard_\w+"?\."?org_id"? = |"?(?:pp|pkg|src|ps)"?\."?org_id"? = /,
      reason:
        'visibleWinner and catalogue-predicates registrations cover the delegated winner and attachment predicates.',
    },
    {
      locate: /v\.org_id = \?/,
      reason:
        'The version selector is tested separately by the foreign-version case in this module.',
    },
  ]),
  factoryEntry('catalogue-dist', 'createDistResolver', foreignVersion, /v\.org_id = \?/, [
    {
      locate: /"?guard_\w+"?\."?org_id"? = |"?(?:pp|pkg|src|ps)"?\."?org_id"? = /,
      reason:
        'visibleWinner and catalogue-predicates cover the delegated winner and attachment predicates.',
    },
    {
      locate: /b\.org_id = \?/,
      reason: 'The foreign-blob case in this module independently tests the blob join.',
    },
  ]),
];
