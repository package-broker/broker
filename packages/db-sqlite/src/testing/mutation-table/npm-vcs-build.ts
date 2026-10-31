import { expect } from 'vitest';
import {
  createNpmVcsBuildReader,
  createNpmVcsBuildPendingReader,
  npmVcsBuildTargetStatement,
} from '../../repositories/npm-vcs-build.js';
import { executing, factoryEntry } from './factory-cases.js';
import { seedSource, seedPackage, seedVersion, NOT_NULL, ref } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const targetEntries: readonly MutationEntry[] = [
  'npmVcsBuildTargetStatement',
  'createNpmVcsBuildReader',
].map((builder) => {
  const cases: ContractCase[] = ['version', 'package', 'source'].map((part) => ({
    name: `${builder} refuses a foreign ${part}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(
        seed.forged,
        'NS',
        part === 'source' ? foreign.orgId : own.orgId,
        'vcs',
        'npm',
      );
      await seedPackage(
        seed.forged,
        'NP',
        part === 'package' ? foreign.orgId : own.orgId,
        'NS',
        'widget',
        'npm',
      );
      await seedVersion(
        seed.forged,
        'NV',
        part === 'version' ? foreign.orgId : own.orgId,
        'NP',
        '1.0.0',
      );
      await seed("UPDATE version SET source_ref=?,dist_type='tgz' WHERE id='NV'", 'a'.repeat(40));
      const input = { sourceId: 'NS', packageId: 'NP', versionId: 'NV' };
      if (builder === 'createNpmVcsBuildReader')
        expect(await createNpmVcsBuildReader(executing(context))(own, input)).toBeNull();
      else
        expect(
          await context.executor.all(context.mutate(npmVcsBuildTargetStatement(own, input))),
        ).toEqual([]);
    },
  }));
  return {
    file: 'repositories/npm-vcs-build.ts',
    builder,
    cases,
    predicates: ['nv', 'np', 'ns'].map((alias, index) => ({
      name: `${alias} belongs to the organization`,
      locate: ref(alias, 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: cases[index]!.name,
    })),
  };
});

export const entries: readonly MutationEntry[] = [
  ...targetEntries,
  factoryEntry(
    'npm-vcs-build',
    'createNpmVcsBuildPendingReader',
    {
      name: 'pending builds exclude jobs in a foreign organization',
      async run(context) {
        const { own, foreign } = orgOf(context);
        const seed = seeder(context.executor);
        await seed(
          "INSERT INTO job (id,org_id,type,idempotency_key,resource_key,state) VALUES ('PB',?,'core:npm-vcs-build:v1','pending','V','queued')",
          foreign.orgId,
        );
        expect(await createNpmVcsBuildPendingReader(executing(context))(own, 'V')).toBe(false);
      },
    },
    /"org_id" = \?/,
  ),
];
