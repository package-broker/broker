import type { MutationEntry } from './harness.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type DecisionCheck,
} from './harness.js';
import { expect } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import type { SyncResult } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { distTagStatements, type DistTagRequest } from '../../repositories/catalogue-write-tags.js';
import {
  A_JOB,
  OWNER,
  FUTURE,
  seedSource,
  seedPackage,
  seedVersion,
  ref,
  NOT_NULL,
} from './fixtures.js';

const OWN_TARGET =
  'the check of the tag that points at a version of this organization: stripping it cannot change the outcome';

const ABORTED_BY_CHECK =
  'emitted after a failing check, so the batch never runs it; the sync actor scenario runs the same statements';

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

function tagRequest(tags: Record<string, string>, actorType: 'user' | 'sync'): DistTagRequest {
  return {
    packageId: 'K-NPM',
    ecosystem: 'npm',
    tags,
    actorType,
    actorId: null,
    opId: '01J0OP0000000000000000M001',
  };
}

async function applyTagPlan(
  context: CaseContext,
  tags: Record<string, string>,
  actorType: 'user' | 'sync',
): Promise<SyncResult | null> {
  const { own } = orgOf(context);
  const guard = createCatalogueWriteGuard(own, { id: A_JOB, owner: OWNER, fence: 3 });
  const plan = distTagStatements(own, guard, tagRequest(tags, actorType));
  try {
    return plan.result(await context.executor.batch(context.mutateBatch(plan.statements)));
  } catch (error) {
    if (!String(error).includes(ACCESS_MUTATION_GUARD_CONSTRAINT)) throw error;
    return null;
  }
}

async function tagCount(context: CaseContext): Promise<number> {
  const rows = await context.executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM dist_tag WHERE package_id = ?',
    params: ['K-NPM'],
  });
  return rows[0]?.n ?? -1;
}

async function historyCount(context: CaseContext): Promise<number> {
  const rows = await context.executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM dist_tag_history WHERE package_id = ?',
    params: ['K-NPM'],
  });
  return rows[0]?.n ?? -1;
}

const tagOnForeignPackage: ContractCase = {
  name: 'a dist tag is not written onto a package of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedTagFixture(context, { packageOrg: foreign.orgId, versionOrg: own.orgId });
    expect(await applyTagPlan(context, { latest: '1.0.0' }, 'user')).toBeNull();
    expect(await tagCount(context)).toBe(0);
  },
};

const tagToForeignVersion: ContractCase = {
  name: 'a dist tag does not point at a version of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: foreign.orgId });
    expect(await applyTagPlan(context, { latest: '2.0.0', next: '1.0.0' }, 'user')).toBeNull();
    expect(await tagCount(context)).toBe(0);
    const synced = await applyTagPlan(context, { next: '1.0.0' }, 'sync');
    expect(synced?.skippedTags).toEqual(['next']);
    expect(await tagCount(context)).toBe(0);
    expect(await historyCount(context)).toBe(0);
  },
};

const tagRemovalSpares: ContractCase = {
  name: 'removing absent dist tags leaves rows of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: own.orgId });
    await seeder(context.executor)(
      'INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)',
      foreign.orgId,
      'K-NPM',
      'old',
      'V1',
    );
    await applyTagPlan(context, {}, 'sync');
    expect(await tagCount(context)).toBe(1);
    expect(await historyCount(context)).toBe(0);
  },
};

function tagForeignRowCase(sameVersion: boolean): ContractCase {
  return {
    name: sameVersion
      ? 'a foreign tag at the requested version suppresses phantom history'
      : 'a foreign tag is neither the previous value nor updated on conflict',
    async run(context) {
      const { own, foreign } = orgOf(context);
      await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: own.orgId });
      await seeder(context.executor)(
        "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, 'K-NPM', 'latest', ?)",
        foreign.orgId,
        sameVersion ? 'V2' : 'V1',
      );
      expect(await applyTagPlan(context, { latest: '2.0.0' }, 'sync')).not.toBeNull();
      const history = await context.executor.all<{ previous_version_id: string | null }>({
        sql: "SELECT previous_version_id FROM dist_tag_history WHERE org_id = ? AND package_id = 'K-NPM' AND tag = 'latest'",
        params: [own.orgId],
      });
      expect(history).toEqual([]);
      const tags = await context.executor.all<{ org_id: string; version_id: string }>({
        sql: "SELECT org_id, version_id FROM dist_tag WHERE org_id = ? AND package_id = 'K-NPM' AND tag = 'latest'",
        params: [foreign.orgId],
      });
      expect(tags).toEqual([{ org_id: foreign.orgId, version_id: sameVersion ? 'V2' : 'V1' }]);
    },
  };
}

const tagsAdvanceOnce: ContractCase = {
  name: 'multiple tag changes advance the package revision once per batch',
  async run(context) {
    const { own } = orgOf(context);
    await seedTagFixture(context, { packageOrg: own.orgId, versionOrg: own.orgId });
    const before = await context.executor.all<{ rev: number }>({
      sql: "SELECT rev FROM package WHERE id = 'K-NPM'",
      params: [],
    });
    const guard = createCatalogueWriteGuard(own, { id: A_JOB, owner: OWNER, fence: 3 });
    const plan = distTagStatements(
      own,
      guard,
      tagRequest({ latest: '1.0.0', next: '2.0.0', stable: '1.0.0' }, 'sync'),
    );
    await context.executor.batch(context.mutateBatch(plan.statements));
    expect(await tagCount(context)).toBe(3);
    expect(await historyCount(context)).toBe(3);
    const after = await context.executor.all<{ rev: number }>({
      sql: "SELECT rev FROM package WHERE id = 'K-NPM'",
      params: [],
    });
    expect(after[0]?.rev).toBe((before[0]?.rev ?? -1) + 1);
  },
};

const tagPlanStatements = (tagCountInRequest: number): readonly Statement[] => {
  const org = { orgId: '01J00000000000000000000A0A' } as OrgContext;
  const guard = createCatalogueWriteGuard(org, { id: A_JOB, owner: OWNER, fence: 3 });
  const tags = Object.fromEntries(
    Array.from({ length: tagCountInRequest }, (_, index) => [`tag${String(index)}`, '1.0.0']),
  );
  return distTagStatements(org, guard, tagRequest(tags, 'sync')).statements;
};

function revisionClockCheck(tagsInRequest: number): DecisionCheck {
  return {
    name: `the package revision clock is read once for ${String(tagsInRequest)} tags`,
    pattern: /max\(\s*unixepoch\('now', 'subsec'\)/,
    expected: 1,
    build: () => tagPlanStatements(tagsInRequest),
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'distTagStatements',
    file: 'repositories/catalogue-write-tags.ts',
    waivers: [
      {
        locate: /\bjob\.org_id = \?/,
        reason: 'the lease guard statement, owned by the jobLeaseGuard registration',
      },
    ],
    cases: [
      tagOnForeignPackage,
      tagToForeignVersion,
      tagRemovalSpares,
      tagsAdvanceOnce,
      tagForeignRowCase(false),
      tagForeignRowCase(true),
    ],
    batchDecisions: [
      {
        name: 'package revision advances once for multiple tags',
        pattern: /update "package" set/,
        expected: 1,
        caseName: tagsAdvanceOnce.name,
      },
    ],
    decisions: [revisionClockCheck(1), revisionClockCheck(3)],
    predicates: [
      {
        name: 'foreign tag collisions suppress history and change counts',
        locate: /collision\.org_id <> \?/,
        neutral: 'NULL IS ?',
        copies: 1,
        caseName: tagForeignRowCase(false).name,
      },
      {
        name: 'package rows are scoped to the organization',
        locate: ref('package', 'org_id', '\\?'),
        neutral: NOT_NULL,
        waivedCopies: {
          1: 'the revision advance of a package of another organization is unreachable: the head check above it already aborts the batch',
        },
        caseName: tagOnForeignPackage.name,
      },
      {
        name: 'version rows are scoped to the organization',
        locate: ref('version', 'org_id', '\\?'),
        neutral: NOT_NULL,
        waivedCopies: {
          0: OWN_TARGET,
          2: ABORTED_BY_CHECK,
          3: ABORTED_BY_CHECK,
          4: ABORTED_BY_CHECK,
          5: ABORTED_BY_CHECK,
        },
        caseName: tagToForeignVersion.name,
      },
      {
        name: 'removed dist tag rows are scoped to the organization',
        locate: ref('dist_tag', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: tagRemovalSpares.name,
      },
      {
        name: 'previous tag value is scoped to the organization',
        waivedCopies: {
          0: 'foreign tag rows are excluded by the collision guard before history is inserted',
        },
        locate: /dist_tag\.org_id = \?(?=\s+AND dist_tag.tag = \?\))/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: tagForeignRowCase(false).name,
      },
      {
        name: 'unchanged tag check is scoped to the organization',
        waivedCopies: {
          0: 'foreign tag rows are excluded by the collision guard before history is inserted',
        },
        locate:
          /dist_tag\.org_id = \?(?=\s+AND dist_tag.tag = \? AND dist_tag.version_id = version.id)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: tagForeignRowCase(true).name,
      },
      {
        name: 'conflict update is scoped to the organization',
        locate: /dist_tag\.org_id = \?(?= AND dist_tag.version_id IS NOT excluded.version_id)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: tagForeignRowCase(false).name,
      },
    ],
  },
];
