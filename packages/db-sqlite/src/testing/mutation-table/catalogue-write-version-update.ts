import { expect } from 'vitest';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { versionUpdateStatements } from '../../repositories/catalogue-write-version-update.js';
import { orgOf, seeder, type ContractCase } from './harness.js';
import {
  seedSource,
  seedPackage,
  seedVersion,
  WRITE_GUARD,
  A_JOB,
  OWNER,
  FUTURE,
} from './fixtures.js';
const foreignSource: ContractCase = {
  name: 'a foreign VCS source cannot suppress an npm integrity conflict',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'VS', foreign.orgId, 'vcs', 'npm');
    await seedPackage(seed.forged, 'VP', own.orgId, 'VS', 'widget', 'npm');
    await seedVersion(seed, 'VV', own.orgId, 'VP', '1.0.0');
    const metadata = normalizeVersionMetadata('npm', {
      name: 'widget',
      version: '1.0.0',
      gitHead: 'a'.repeat(40),
    });
    await seed(
      "UPDATE version SET metadata_json=?, npm_integrity=? WHERE id='VV'",
      metadata.json,
      `sha512-${'A'.repeat(86)}==`,
    );
    await seed(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES (?,?,'sync:v1','vcs-conflict','running',?,?,3)",
      A_JOB,
      own.orgId,
      OWNER,
      FUTURE,
    );
    const plan = versionUpdateStatements(own, createCatalogueWriteGuard(own, WRITE_GUARD), {
      packageId: 'VP',
      ecosystem: 'npm',
      versions: [
        {
          version: '1.0.0',
          versionNormalized: '1.0.0',
          license: null,
          distType: 'tgz',
          sourceRef: 'a'.repeat(40),
          upstreamReleasedAt: null,
          history: { basis: 'import_time', at: '2026-01-01T00:00:00.000Z', noOtherDate: true },
          metadata,
        },
      ],
    });
    expect(
      plan.result(await context.executor.batch(plan.statements.map(context.mutate))).conflicts,
    ).toEqual(['1.0.0']);
  },
};
import { type MutationEntry } from './harness.js';
import { monotonicDecisions, writeTimeCase } from './catalogue-time-cases.js';

export const entries: readonly MutationEntry[] = [
  {
    builder: 'versionUpdateStatements',
    file: 'repositories/catalogue-write-version-update.ts',
    cases: [foreignSource],
    predicates: [
      {
        name: 'the VCS exception reads an own source',
        locate: /source.org_id = version.org_id/,
        neutral: '1=1',
        copies: 1,
        caseName: foreignSource.name,
      },
    ],
    waivers: [
      {
        locate: /job.org_id = \?|package.org_id = \?|"package"\."org_id" = \?|version.org_id = \?/,
        reason:
          'The existing job, package and version identity scopes are independently covered by the catalogue writer mutation entry and its foreign-target cases. This added case isolates the VCS-source exception.',
      },
      {
        locate: /package.org_id=version.org_id/,
        reason:
          'The package is already required to match the organization by the batch assertion before any conflict read; this correlated join repeats that proven identity.',
      },
    ],
    sqlDecisions: [
      ...monotonicDecisions('update'),
      ...monotonicDecisions('update', 'composer'),
      {
        name: 'an unchanged update batch preserves the package clock',
        pattern:
          /version.upstream_released_at IS NOT json_extract\(incoming.value, '\$.upstream'\)/,
        replacement: "version.upstream_released_at IS json_extract(incoming.value, '$.upstream')",
        expected: 1,
        case: writeTimeCase('update', 'unchanged'),
      },
    ],
    batchDecisions: [
      {
        name: 'multiple updated versions read the clock once',
        pattern: /(?:strftime\('[^']*', 'now'(?:, '[^']*')?\)|unixepoch\('now'(?:, '[^']*')?\))/,
        expected: 1,
        caseName: writeTimeCase('update', 'future').name,
        case: writeTimeCase('update', 'future'),
      },
      {
        name: 'multiple updated versions advance the package clock once',
        pattern: /update "package" set/,
        expected: 1,
        caseName: writeTimeCase('update', 'future').name,
        case: writeTimeCase('update', 'future'),
      },
      {
        name: 'multiple Composer revisions advance the package clock once',
        pattern: /update "package" set/,
        expected: 1,
        caseName: writeTimeCase('update', 'future', 'composer').name,
        case: writeTimeCase('update', 'future', 'composer'),
      },
    ],
  },
];
