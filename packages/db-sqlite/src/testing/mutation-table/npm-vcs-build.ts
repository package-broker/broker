import { expect } from 'vitest';
import {
  npmVcsBuildRetryStatement,
  createNpmVcsBuildOutcomes,
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
  for (const field of ['generation', 'terminal'] as const)
    cases.push({
      name: `${builder} ignores a foreign ${field} outcome`,
      async run(context) {
        const { own, foreign } = orgOf(context);
        const seed = seeder(context.executor);
        await seedSource(seed, 'NS', own.orgId, 'vcs', 'npm');
        await seedPackage(seed, 'NP', own.orgId, 'NS', 'widget', 'npm');
        await seedVersion(seed, 'NV', own.orgId, 'NP', '1.0.0');
        await seed("UPDATE version SET source_ref=?,dist_type='tgz' WHERE id='NV'", 'a'.repeat(40));
        await seed.forged(
          "INSERT INTO npm_vcs_build_outcome (org_id,version_id,source_ref,packing_policy,retry_generation,outcome) VALUES (?, 'NV', ?, 'npm-pack-v1', 9, 'too_large')",
          foreign.orgId,
          'a'.repeat(40),
        );
        const input = { sourceId: 'NS', packageId: 'NP', versionId: 'NV' };
        const rows =
          builder === 'createNpmVcsBuildReader'
            ? [await createNpmVcsBuildReader(executing(context))(own, input)]
            : await context.executor.all(context.mutate(npmVcsBuildTargetStatement(own, input)));
        expect(rows[0]).toMatchObject({ retryGeneration: 0 });
      },
    });
  return {
    file: 'repositories/npm-vcs-build.ts',
    builder,
    cases,
    predicates: [
      ...['nv', 'np', 'ns'].map((alias, index) => ({
        name: `${alias} belongs to the organization`,
        locate: ref(alias, 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: cases[index]!.name,
      })),
      ...['bo', 'terminal'].map((alias, index) => ({
        name: `${alias} outcome belongs to the organization`,
        locate: new RegExp(`${alias}\\.org_id = \\?`),
        neutral: NOT_NULL,
        copies: 1,
        caseName: cases[3 + index]!.name,
      })),
    ],
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

const outcomeCases: ContractCase[] = ['ov', 'op', 'os'].map((alias) => ({
  name: `build outcome excludes foreign ${alias}`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed.forged, 'OS', alias === 'os' ? foreign.orgId : own.orgId, 'vcs', 'npm');
    await seedPackage(
      seed.forged,
      'OP',
      alias === 'op' ? foreign.orgId : own.orgId,
      'OS',
      'widget',
      'npm',
    );
    await seedVersion(seed.forged, 'OV', alias === 'ov' ? foreign.orgId : own.orgId, 'OP', '1.0.0');
    await seed("UPDATE version SET source_ref=?,dist_type='tgz' WHERE id='OV'", 'a'.repeat(40));
    await seed(
      "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('OJ',?,'core:npm-vcs-build:v1','outcome','running','worker','2999-01-01T00:00:00.000Z',1)",
      own.orgId,
    );
    await expect(
      createNpmVcsBuildOutcomes(executing(context)).start(
        own,
        { id: 'OJ', owner: 'worker', fence: 1 },
        {
          sourceId: 'OS',
          packageId: 'OP',
          versionId: 'OV',
          version: '1.0.0',
          sourceRef: 'a'.repeat(40),
          packingPolicy: 'npm-pack-v1',
          retryGeneration: 0,
        },
      ),
    ).rejects.toThrow();
  },
}));
outcomeCases.push({
  name: 'outcome ignores a foreign retry generation',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'GS', own.orgId, 'vcs', 'npm');
    await seedPackage(seed, 'GP', own.orgId, 'GS', 'widget', 'npm');
    await seedVersion(seed, 'GV', own.orgId, 'GP', '1.0.0');
    await seed("UPDATE version SET source_ref=? WHERE id='GV'", 'a'.repeat(40));
    await seed.forged(
      "INSERT INTO npm_vcs_build_outcome (org_id,version_id,source_ref,packing_policy,retry_generation) VALUES (?, 'GV', ?, 'npm-pack-v1', 9)",
      foreign.orgId,
      'a'.repeat(40),
    );
    await seed(
      "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('GJ',?,'core:npm-vcs-build:v1','foreign-generation','running','worker','2999-01-01T00:00:00.000Z',1)",
      own.orgId,
    );
    await expect(
      createNpmVcsBuildOutcomes(executing(context)).start(
        own,
        { id: 'GJ', owner: 'worker', fence: 1 },
        {
          sourceId: 'GS',
          packageId: 'GP',
          versionId: 'GV',
          version: '1.0.0',
          sourceRef: 'a'.repeat(40),
          packingPolicy: 'npm-pack-v1',
          retryGeneration: 0,
        },
      ),
    ).resolves.toBeUndefined();
  },
});
const terminalCases: ContractCase[] = ['bo', 'tv', 'tp'].map((part) => ({
  name: `terminal outcome excludes foreign ${part}`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'TS', own.orgId, 'vcs', 'npm');
    await seedPackage(
      seed.forged,
      'TP',
      part === 'tp' ? foreign.orgId : own.orgId,
      'TS',
      'widget',
      'npm',
    );
    await seedVersion(seed.forged, 'TV', part === 'tv' ? foreign.orgId : own.orgId, 'TP', '1.0.0');
    await seed("UPDATE version SET source_ref=? WHERE id='TV'", 'a'.repeat(40));
    await seed.forged(
      "INSERT INTO npm_vcs_build_outcome (org_id,version_id,source_ref,packing_policy,outcome) VALUES (?, 'TV', ?, 'npm-pack-v1', 'too_large')",
      part === 'bo' ? foreign.orgId : own.orgId,
      'a'.repeat(40),
    );
    expect(
      await createNpmVcsBuildOutcomes(executing(context)).terminal(own, {
        sourceId: 'TS',
        packageId: 'TP',
        versionId: 'TV',
      }),
    ).toBe(false);
  },
}));
(entries as MutationEntry[]).push({
  file: 'repositories/npm-vcs-build.ts',
  builder: 'createNpmVcsBuildOutcomes',
  cases: [...outcomeCases, ...terminalCases],
  predicates: [
    ...['bo', 'tv', 'tp'].map((alias) => ({
      name: `terminal ${alias} scope`,
      locate: ref(alias, 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: `terminal outcome excludes foreign ${alias}`,
    })),
    ...['ov', 'op', 'os', 'fence_outcome'].map((alias, index) => ({
      name: `${alias} outcome scope`,
      locate: new RegExp(`${alias}\\.org_id = \\?`),
      neutral: NOT_NULL,
      copies: 1,
      caseName: outcomeCases[index]!.name,
    })),
  ],
  waivers: [
    {
      locate: /job\.org_id = /,
      reason: 'Delegated jobLeaseGuard has independent organization and lease mutation cases.',
    },
  ],
});

const retryCases: ContractCase[] = ['outcome', 'rv', 'rp', 'rs'].map((part) => ({
  name: `retry preserves a foreign ${part}`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed.forged, 'RS', part === 'rs' ? foreign.orgId : own.orgId, 'vcs', 'npm');
    await seedPackage(
      seed.forged,
      'RP',
      part === 'rp' ? foreign.orgId : own.orgId,
      'RS',
      'widget',
      'npm',
    );
    await seedVersion(seed.forged, 'RV', part === 'rv' ? foreign.orgId : own.orgId, 'RP', '1.0.0');
    await seed.forged(
      "INSERT INTO npm_vcs_build_outcome (org_id,version_id,source_ref,packing_policy,outcome) VALUES (?, 'RV', ?, 'npm-pack-v1', 'too_large')",
      part === 'outcome' ? foreign.orgId : own.orgId,
      'a'.repeat(40),
    );
    await executing(context).batch([npmVcsBuildRetryStatement(own, 'RS')]);
    expect(
      await context.executor.all({
        sql: "SELECT outcome FROM npm_vcs_build_outcome WHERE version_id='RV'",
        params: [],
      }),
    ).toEqual([{ outcome: 'too_large' }]);
  },
}));
(entries as MutationEntry[]).push({
  file: 'repositories/npm-vcs-build.ts',
  builder: 'npmVcsBuildRetryStatement',
  cases: retryCases,
  predicates: ['outcome', 'rv', 'rp', 'rs'].map((part, index) => ({
    name: `retry ${part} scope`,
    locate: part === 'outcome' ? /(?<!\.)"org_id" = \?/ : ref(part, 'org_id', '\\?'),
    neutral: NOT_NULL,
    copies: 1,
    caseName: retryCases[index]!.name,
  })),
});

function staleBuildCase(part: 'commit' | 'retry'): ContractCase {
  return {
    name: `outcome rejects a stale ${part}`,
    async run(context) {
      const { own } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'FS', own.orgId, 'vcs', 'npm');
      await seedPackage(seed, 'FP', own.orgId, 'FS', 'widget', 'npm');
      await seedVersion(seed, 'FV', own.orgId, 'FP', '1.0.0');
      await seed(
        "UPDATE version SET source_ref=?,dist_type='tgz' WHERE id='FV'",
        (part === 'commit' ? 'b' : 'a').repeat(40),
      );
      await seed(
        "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('FJ',?,'core:npm-vcs-build:v1','stale','running','worker','2999-01-01T00:00:00.000Z',1)",
        own.orgId,
      );
      if (part === 'retry')
        await seed(
          "INSERT INTO npm_vcs_build_outcome (org_id,version_id,source_ref,packing_policy,retry_generation) VALUES (?, 'FV', ?, 'npm-pack-v1', 1)",
          own.orgId,
          'a'.repeat(40),
        );
      await expect(
        createNpmVcsBuildOutcomes(executing(context)).finish(
          own,
          { id: 'FJ', owner: 'worker', fence: 1 },
          {
            sourceId: 'FS',
            packageId: 'FP',
            versionId: 'FV',
            version: '1.0.0',
            sourceRef: 'a'.repeat(40),
            packingPolicy: 'npm-pack-v1',
            retryGeneration: 0,
          },
          'too_large',
        ),
      ).rejects.toThrow();
    },
  };
}
const outcomeEntry = entries.find((entry) => entry.builder === 'createNpmVcsBuildOutcomes')!;
Object.assign(outcomeEntry, {
  sqlDecisions: [
    {
      name: 'immutable commit fence',
      pattern: /ov\.source_ref = \?/,
      replacement: '? IS NOT NULL',
      expected: 1,
      case: staleBuildCase('commit'),
    },
    {
      name: 'deliberate retry generation fence',
      pattern: /\), 0\) = \?/,
      replacement: '), 0) >= ?',
      expected: 1,
      case: staleBuildCase('retry'),
    },
  ],
});
