import { expect } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import type { OrgContext } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { createBlobReplacer } from '../../repositories/blob-replacer.js';
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
  guardPasses,
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

type Stage = 'precheck' | 'before-image' | 'replace' | 'postcondition' | 'advance';
type Table = 'version' | 'package' | 'blob' | 'before';
const stages: readonly [Stage, readonly Table[]][] = [
  ['precheck', ['version', 'package', 'blob']],
  ['before-image', ['version', 'package', 'blob']],
  ['replace', ['version', 'blob', 'before']],
  ['postcondition', ['version', 'blob', 'before']],
  ['advance', ['package', 'version']],
];

function probe(stage: Stage, table: Table): ContractCase {
  return {
    name: `re-blob scopes ${table} in its ${stage}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      const scopedOrg = (candidate: Table) => (candidate === table ? foreign.orgId : own.orgId);
      await seedSource(seed, 'S', own.orgId, 'composer_repository');
      await seedPackage(seed, 'K', scopedOrg('package'), 'S', 'acme/widget');
      await seedVersion(seed, 'V', scopedOrg('version'), 'K', '1.0.0');
      await seed(
        'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
        'OLD',
        own.orgId,
        HASH,
        'old',
      );
      await seed(
        'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
        'NEW',
        scopedOrg('blob'),
        OTHER_HASH,
        'new',
      );
      await seed("UPDATE version SET blob_id = 'OLD' WHERE id = 'V'");
      const guard = createCatalogueWriteGuard(own, WRITE_GUARD);
      const plan = replaceBlobStatements(own, guard, {
        versionId: 'V',
        expectedRevision: 1,
        oldBlobId: 'OLD',
        newSha256: OTHER_HASH as Sha256,
        reason: 'refetch_changed',
      });
      const statements = plan.statements.slice(guard.length);
      const index = stages.findIndex(([name]) => name === stage);
      const statement = statements[index];
      if (statement === undefined) throw new Error('re-blob statement missing');
      if (stage === 'replace' || stage === 'postcondition') {
        await seed(
          `INSERT INTO version_revision (id, org_id, version_id, revision, blob_id,
            metadata_json, reason, op_id) VALUES ('R', ?, 'V', 1, 'OLD', '{}', 'refetch_changed', ?)`,
          scopedOrg('before'),
          plan.opId,
        );
      }
      if (stage === 'postcondition') {
        await seed(
          "UPDATE version SET blob_id = 'NEW', revision = 2, last_op_id = ? WHERE id = 'V'",
          plan.opId,
        );
      } else if (stage === 'advance') {
        await seed("UPDATE version SET last_op_id = ? WHERE id = 'V'", plan.opId);
      }
      if (stage === 'precheck' || stage === 'postcondition') {
        expect(await guardPasses(context, [statement], true)).toBe(false);
        return;
      }
      const [result] = await context.executor.batch([context.mutate(statement)]);
      if (stage === 'replace' && table === 'blob') {
        // The standalone update can assign NULL; the batch postcondition refuses that result.
        expect(result?.changes).toBe(1);
        expect(
          await context.executor.all({
            sql: "SELECT blob_id FROM version WHERE id = 'V'",
            params: [],
          }),
        ).toEqual([{ blob_id: null }]);
      } else {
        expect(result?.changes).toBe(0);
      }
    },
  };
}

const reblobCases = REBLOB_STAGES.flatMap(([stage, tables]) =>
  tables.map((table) => ({ stage, table, contractCase: reblobCase(stage, table) })),
);

const reblobEntry: MutationEntry = {
  builder: 'replaceBlobStatements',
  file: 'repositories/catalogue-reblob.ts',
  cases: [
    ...reblobCases.map(({ contractCase }) => contractCase),
    ...stages.flatMap(([stage, tables]) => tables.map((table) => probe(stage, table))),
  ],
  predicates: [
    ...reblobCases.map(({ stage, table, contractCase }) => ({
      name: `${stage} scopes ${table} to the organization`,
      locate: ref(table, 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: contractCase.name,
    })),
    ...stages.flatMap(([stage, tables]) =>
      tables.map((table) => ({
        name: `${stage} ${table}`,
        locate: ref(table, 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: probe(stage, table).name,
      })),
    ),
  ],
  decisions: [
    {
      name: 'blob replacement reads the revision clock once',
      pattern: REVISION_CLOCK,
      expected: 1,
      build: () => reblobPlan(WRITE_ORG).statements,
    },
    {
      name: 'blob replacement reads the clock twice including its lease guard',
      pattern:
        /(?:strftime\('[^']*',\s*'now'(?:,\s*'[^']*')?\)|unixepoch\('now'(?:,\s*'[^']*')?\))/,
      expected: 2,
      build: () => reblobPlan(WRITE_ORG).statements,
    },
  ],
};

function replacerCase(foreignJob: boolean): ContractCase {
  return {
    name: `blob replacer ${foreignJob ? 'refuses a foreign job without writes' : 'replaces only the requested version'}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: own.orgId });
      for (const [id, ctx, hash] of [
        ['B-OLD', own, HASH],
        ['B-NEW', own, OTHER_HASH],
        ['B-FOREIGN', foreign, OTHER_HASH],
      ] as const)
        await seedBlobRow(seed, id, ctx.orgId, hash);
      await seed("UPDATE version SET blob_id = 'B-OLD' WHERE id IN ('V1', 'V2')");
      if (foreignJob) await seed('UPDATE job SET org_id = ? WHERE id = ?', foreign.orgId, A_JOB);
      const snapshot = async () =>
        Promise.all(
          ['version', 'version_revision', 'package', 'blob', 'job', 'cache_epoch'].map((table) =>
            context.executor.all({ sql: `SELECT * FROM ${table} ORDER BY rowid`, params: [] }),
          ),
        );
      const before = await snapshot();
      const replacer = createBlobReplacer({
        driver: context.executor.driver,
        all: () => {
          throw new Error('replacement must use a batch');
        },
        batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
      });
      const operation = replacer.replaceBlob(own, createCatalogueWriteGuard(own, WRITE_GUARD), {
        versionId: 'V1',
        expectedRevision: 1,
        oldBlobId: 'B-OLD',
        newSha256: OTHER_HASH as Sha256,
        reason: 'refetch_changed',
      });
      if (foreignJob) {
        await expect(operation).rejects.toThrow(ACCESS_MUTATION_GUARD_CONSTRAINT);
        expect(await snapshot()).toEqual(before);
      } else {
        await expect(operation).resolves.toEqual({ changed: true, statements: 6 });
        expect(
          await context.executor.all({
            sql: 'SELECT id, blob_id, revision FROM version ORDER BY id',
            params: [],
          }),
        ).toEqual([
          { id: 'V1', blob_id: 'B-NEW', revision: 2 },
          { id: 'V2', blob_id: 'B-OLD', revision: 1 },
        ]);
        expect((await snapshot())[3]).toEqual(before[3]);
      }
    },
  };
}

export const entries: readonly MutationEntry[] = [
  reblobEntry,
  {
    builder: 'createBlobReplacer',
    file: 'repositories/blob-replacer.ts',
    cases: [replacerCase(false), replacerCase(true)],
    predicates: [
      {
        name: 'replacement delegates the organization scoped job fence',
        locate: ref('job', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: replacerCase(true).name,
      },
    ],
    waivers: [
      {
        locate: /"?(?:version|package|blob|before)"?\."?org_id"? = \?/,
        reason:
          'The factory forwards replaceBlobStatements unchanged in one atomic batch. Its precheck, before-image, replacement, postcondition and package predicates are independently mutated by the replaceBlobStatements registration above; earlier checks mask individual downstream mutations in a complete batch.',
      },
    ],
  },
];
