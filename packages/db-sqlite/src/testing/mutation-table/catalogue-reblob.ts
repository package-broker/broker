import { expect } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import type { OrgContext } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { replaceBlobStatements } from '../../repositories/catalogue-reblob.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type Seed,
  type MutationEntry,
} from './harness.js';
import {
  A_JOB,
  OWNER,
  FUTURE,
  HASH,
  OTHER_HASH,
  WRITE_GUARD,
  WRITE_ORG,
  REVISION_CLOCK,
  ref,
  NOT_NULL,
  seedSource,
  seedPackage,
  seedVersion,
} from './fixtures.js';

async function seedTagFixture(
  context: CaseContext,
  options: { packageOrg: string; versionOrg: string },
): Promise<void> {
  const seed = seeder(context.executor);
  const { own } = orgOf(context);
  await seed(
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
      VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
    A_JOB,
    own.orgId,
    `k:${A_JOB}`,
    OWNER,
    FUTURE,
  );
  await seedSource(seed, 'S-NPM', options.packageOrg, 'npm_registry', 'npm');
  await seedPackage(seed, 'K-NPM', options.packageOrg, 'S-NPM', 'widget', 'npm');
  await seedVersion(seed, 'V1', options.versionOrg, 'K-NPM', '1.0.0');
  await seedVersion(seed, 'V2', orgOf(context).own.orgId, 'K-NPM', '2.0.0');
}

const OLD = '2020-01-01T00:00:00.000Z';

async function seedBlobRow(seed: Seed, id: string, orgId: string, sha: string): Promise<void> {
  await seed(
    'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable, published_at) VALUES (?, ?, ?, 1, ?, 1, ?)',
    id,
    orgId,
    sha,
    id,
    OLD,
  );
}

type ReblobStage = 'guard' | 'precheck' | 'before-image' | 'replace' | 'postcondition' | 'advance';
type ReblobTable = 'job' | 'version' | 'package' | 'blob' | 'before';

const REBLOB_STAGES: readonly [ReblobStage, readonly ReblobTable[]][] = [
  ['guard', ['job']],
  ['precheck', ['version', 'package', 'blob']],
  ['before-image', ['version', 'package', 'blob']],
  ['replace', ['version', 'blob', 'before']],
  ['postcondition', ['version', 'blob', 'before']],
  ['advance', ['package', 'version']],
];

function reblobPlan(ctx: OrgContext) {
  return replaceBlobStatements(ctx, createCatalogueWriteGuard(ctx, WRITE_GUARD), {
    versionId: 'V1',
    expectedRevision: 1,
    oldBlobId: 'B-OLD',
    newSha256: OTHER_HASH as Sha256,
    reason: 'refetch_changed',
  });
}

function reblobCase(stage: ReblobStage, table: ReblobTable): ContractCase {
  return {
    name: `blob replacement ${stage} excludes a foreign ${table} row`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: own.orgId });
      await seedBlobRow(seed, 'B-OLD', own.orgId, HASH);
      await seedBlobRow(seed, 'B-NEW', table === 'blob' ? foreign.orgId : own.orgId, OTHER_HASH);
      await seed("UPDATE version SET blob_id = 'B-OLD' WHERE id = 'V1'");
      const plan = reblobPlan(own);
      if (stage === 'replace' || stage === 'postcondition') {
        await seed(
          `INSERT INTO version_revision
            (id, org_id, version_id, revision, blob_id, metadata_json, reason, op_id)
            VALUES ('VR-REBLOB', ?, 'V1', 1, 'B-OLD', '{}', 'refetch_changed', ?)`,
          table === 'before' ? foreign.orgId : own.orgId,
          plan.opId,
        );
      }
      if (stage === 'postcondition' || stage === 'advance') {
        await seed(
          "UPDATE version SET revision = 2, blob_id = 'B-NEW', last_op_id = ? WHERE id = 'V1'",
          plan.opId,
        );
      }
      if (table === 'version')
        await seed("UPDATE version SET org_id = ? WHERE id = 'V1'", foreign.orgId);
      if (table === 'package')
        await seed("UPDATE package SET org_id = ? WHERE id = 'K-NPM'", foreign.orgId);
      if (table === 'job')
        await seed('UPDATE job SET org_id = ? WHERE id = ?', foreign.orgId, A_JOB);
      const index = REBLOB_STAGES.findIndex(([candidate]) => candidate === stage);
      const statement = plan.statements[index];
      if (statement === undefined) throw new Error('blob replacement statement missing');
      const snapshot = async () => ({
        versions: await context.executor.all({
          sql: 'SELECT * FROM version ORDER BY id',
          params: [],
        }),
        packages: await context.executor.all({
          sql: 'SELECT * FROM package ORDER BY id',
          params: [],
        }),
        revisions: await context.executor.all({
          sql: 'SELECT * FROM version_revision ORDER BY id',
          params: [],
        }),
      });
      const before = await snapshot();
      // Execute each statement independently so earlier checks cannot mask a missing predicate.
      const execute = () => context.executor.batch([context.mutate(statement)]);
      if (stage === 'guard' || stage === 'precheck' || stage === 'postcondition') {
        await expect(execute()).rejects.toThrow(ACCESS_MUTATION_GUARD_CONSTRAINT);
      } else if (stage === 'replace' && table === 'blob') {
        await execute();
        const rows = await context.executor.all<{ blob_id: string | null; revision: number }>({
          sql: "SELECT blob_id, revision FROM version WHERE id = 'V1'",
          params: [],
        });
        expect(rows).toEqual([{ blob_id: null, revision: 2 }]);
        return;
      } else {
        await execute();
      }
      expect(await snapshot()).toEqual(before);
    },
  };
}

const reblobCases = REBLOB_STAGES.flatMap(([stage, tables]) =>
  tables.map((table) => ({ stage, table, contractCase: reblobCase(stage, table) })),
);

const reblobEntry: MutationEntry = {
  builder: 'replaceBlobStatements',
  file: 'repositories/catalogue-reblob.ts',
  cases: reblobCases.map(({ contractCase }) => contractCase),
  predicates: reblobCases.map(({ stage, table, contractCase }) => ({
    name: `${stage} scopes ${table} to the organization`,
    locate: ref(table, 'org_id', '\\?'),
    neutral: NOT_NULL,
    copies: 1,
    caseName: contractCase.name,
  })),
  decisions: [
    {
      name: 'blob replacement reads the revision clock once',
      pattern: REVISION_CLOCK,
      expected: 1,
      build: () => reblobPlan(WRITE_ORG).statements,
    },
    {
      name: 'blob replacement reads the clock four times including its lease guard',
      pattern:
        /(?:strftime\('[^']*',\s*'now'(?:,\s*'[^']*')?\)|unixepoch\('now'(?:,\s*'[^']*')?\))/,
      expected: 4,
      build: () => reblobPlan(WRITE_ORG).statements,
    },
  ],
};

export const entries: readonly MutationEntry[] = [reblobEntry];
