import { orgOf, seeder, type ContractCase, type Seed, type MutationEntry } from './harness.js';
import { expect } from 'vitest';
import type { Statement } from '@package-broker/core/db/port';
import {
  blobEligibleCondition,
  blobPrematureCondition,
} from '../../repositories/blob-references.js';
import { createBlobRepository } from '../../repositories/blob.js';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { seedSource, seedPackage, FUTURE, NOT_NULL, ALWAYS } from './fixtures.js';

const EXISTS_COPY =
  'the released check treats an inconsistent reference as unreleased, so the blob stays ineligible whatever this copy says';

const HOSTED_COPY =
  'an inconsistent reference already blocks eligibility through the released check';

const UNRELATED_COPY =
  'no foreign ingest/upstream row exists for this digest, so the neutralised scope cannot change the outcome';

interface BlobRef {
  readonly via: 'version' | 'revision';
  readonly versionOrg: string;
  readonly packageOrg: string;
  readonly sourceOrg: string;
  readonly revisionOrg?: string;
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

async function seedBlobRef(seed: Seed, blobId: string, key: string, ref: BlobRef): Promise<void> {
  await seedSource(seed, `S-${key}`, ref.sourceOrg, 'vcs');
  await seedPackage(
    seed.forged,
    `K-${key}`,
    ref.packageOrg,
    `S-${key}`,
    `acme/${key.toLowerCase()}`,
  );
  await seed.forged(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at)
      VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 'upstream', '{}', ?, 'tombstoned', ?)`,
    `V-${key}`,
    ref.versionOrg,
    `K-${key}`,
    OLD,
    ref.via === 'version' ? blobId : null,
    OLD,
  );
  if (ref.via === 'revision') {
    await seed(
      "INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) VALUES (?, ?, ?, 1, ?, '{}', 'test')",
      `VR-${key}`,
      ref.revisionOrg ?? ref.versionOrg,
      `V-${key}`,
      blobId,
    );
  }
}

const blobsEligibleForRetention: ContractCase = {
  name: 'only blobs of the organization with consistent released references are eligible',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    const orgs = {
      versionOrg: own.orgId,
      packageOrg: own.orgId,
      sourceOrg: own.orgId,
    };
    let counter = 0;
    const blob = async (id: string, orgId: string, refs: Record<string, BlobRef>) => {
      counter += 1;
      await seedBlobRow(seed, id, orgId, String(counter).padStart(64, '0'));
      for (const [key, ref] of Object.entries(refs))
        await seedBlobRef(seed, id, `${id}-${key}`, ref);
    };
    const consistent: BlobRef = { via: 'version', ...orgs };
    const foreignAll = {
      versionOrg: foreign.orgId,
      packageOrg: foreign.orgId,
      sourceOrg: foreign.orgId,
    };
    const via = (kind: BlobRef['via'], changes: Partial<BlobRef> = {}): BlobRef => ({
      ...orgs,
      ...changes,
      via: kind,
    });
    await blob('B-OK', own.orgId, { a: consistent });
    await blob('B-FOREIGN', foreign.orgId, { a: via('version', foreignAll) });
    await blob('B-VERS', own.orgId, { a: consistent, b: via('version', foreignAll) });
    const packageAway = { packageOrg: foreign.orgId, sourceOrg: foreign.orgId };
    const sourceAway = { sourceOrg: foreign.orgId };
    await blob('B-PKG', own.orgId, { a: consistent, b: via('version', packageAway) });
    await blob('B-SRC', own.orgId, { a: consistent, b: via('version', sourceAway) });
    await blob('B-RVER', own.orgId, { a: consistent, b: via('revision', foreignAll) });
    await blob('B-RPKG', own.orgId, { a: consistent, b: via('revision', packageAway) });
    await blob('B-RSRC', own.orgId, { a: consistent, b: via('revision', sourceAway) });
    await blob('B-RREV', own.orgId, {
      a: consistent,
      b: via('revision', { revisionOrg: foreign.orgId }),
    });
    await blob('B-ING', own.orgId, {});
    await blob('B-UP', own.orgId, {});
    const sha = async (id: string) =>
      (
        await context.executor.all<{ sha256: string }>({
          sql: 'SELECT sha256 FROM blob WHERE id = ?',
          params: [id],
        })
      )[0]?.sha256 ?? '';
    await seedSource(seed, 'S-ING', foreign.orgId, 'vcs');
    await seed(
      `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)
        VALUES ('ING1', ?, 'source', ?, 'S-ING', 1, 'o', 1, ?, 'running', ?, ?, ?)`,
      foreign.orgId,
      'a'.repeat(64),
      FUTURE,
      await sha('B-ING'),
      OLD,
      OLD,
    );
    await seedPackage(seed.forged, 'K-UP', foreign.orgId, 'S-ING', 'acme/up');
    await seed(
      `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)
        VALUES (?, 'K-UP', 'composer-p2', ?, ?, ?)`,
      foreign.orgId,
      await sha('B-UP'),
      OLD,
      OLD,
    );
    const condition = blobEligibleCondition(own, 'b');
    const statement: Statement = {
      sql: `SELECT b.id AS id FROM blob b WHERE ${condition.sql}`,
      params: condition.params,
    };
    const rows = await context.executor.all<{ id: string }>(context.mutate(statement));
    expect(rows.map((row) => row.id).sort()).toEqual(['B-ING', 'B-OK', 'B-UP']);
  },
};

const blobEntry: MutationEntry = {
  builder: 'blobEligibleCondition',
  file: 'repositories/blob-references.ts',
  cases: [blobsEligibleForRetention],
  waivers: [
    {
      locate: /bref_ru\.org_id = b\.org_id/,
      reason: 'import run guard; no case yet seeds an import run of another organization',
    },
    {
      locate: /bref_ir\.org_id = bref_ru\.org_id/,
      reason: 'import run guard; no case yet seeds an import reference of another organization',
    },
  ],
  predicates: [
    {
      name: 'the blob is scoped to the organization',
      locate: /(?<=\()b\.org_id = \?/,
      neutral: NOT_NULL,
      caseName: blobsEligibleForRetention.name,
      copies: 1,
    },
    {
      name: 'a reference version joins within the blob organization',
      locate: /bref_v\.org_id = b\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 6,
      waivedCopies: {
        0: EXISTS_COPY,
        1: EXISTS_COPY,
        4: HOSTED_COPY,
        5: HOSTED_COPY,
      },
    },
    {
      name: 'a reference package joins within the version organization',
      locate: /bref_p\.org_id = bref_v\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 6,
      waivedCopies: {
        0: EXISTS_COPY,
        1: EXISTS_COPY,
        4: HOSTED_COPY,
        5: HOSTED_COPY,
      },
    },
    {
      name: 'a reference source joins within the package organization',
      locate: /bref_s\.org_id = bref_p\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 6,
      waivedCopies: {
        0: EXISTS_COPY,
        1: EXISTS_COPY,
        4: HOSTED_COPY,
        5: HOSTED_COPY,
      },
    },
    {
      name: 'a reference revision joins within the version organization',
      locate: /bref_r\.org_id = bref_v\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 3,
      waivedCopies: { 0: EXISTS_COPY, 2: HOSTED_COPY },
    },
    {
      name: 'an ingest session is scoped to the blob organization',
      locate: /bref_ing\.org_id = b\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 1,
    },
    {
      name: 'an upstream state is scoped to the blob organization',
      locate: /bref_up\.org_id = b\.org_id/,
      neutral: ALWAYS,
      caseName: blobsEligibleForRetention.name,
      copies: 1,
    },
  ],
};

const orphansScheduledWithinOrganization: ContractCase = {
  name: 'only the own orphan is scheduled, whatever other organizations hold or reference',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    const mutated = {
      all: (statement: Statement) => context.executor.all(context.mutate(statement)),
      batch: (statements: readonly Statement[]) =>
        context.executor.batch(context.mutateBatch(statements)),
    };
    const repo = createBlobRepository(mutated as typeof context.executor);
    const shaOf = (n: number) => String(n).padStart(64, '0');
    await seedBlobRow(seed, 'B-OWN', own.orgId, shaOf(1));
    await seedBlobRow(seed, 'B-TWIN', foreign.orgId, shaOf(1));
    await seedBlobRow(seed, 'B-TWIN-ING', foreign.orgId, shaOf(2));
    await seedBlobRow(seed, 'B-TWIN-UP', foreign.orgId, shaOf(3));
    await seedBlobRow(seed, 'B-ING', own.orgId, shaOf(2));
    await seedBlobRow(seed, 'B-UP', own.orgId, shaOf(3));
    await seedSource(seed, 'S-F', foreign.orgId, 'vcs');
    await seedPackage(seed, 'K-F', foreign.orgId, 'S-F', 'acme/foreign');
    await seed(
      `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)
        VALUES ('ING1', ?, 'source', ?, 'S-F', 1, 'o', 1, ?, 'running', ?, ?, ?)`,
      foreign.orgId,
      'a'.repeat(64),
      FUTURE,
      shaOf(2),
      OLD,
      OLD,
    );
    await seed(
      `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)
        VALUES (?, 'K-F', 'composer-p2', ?, ?, ?)`,
      foreign.orgId,
      shaOf(3),
      OLD,
      OLD,
    );
    const scheduled = [
      await repo.scheduleOrphan(own, shaOf(1) as Sha256),
      await repo.scheduleOrphan(own, shaOf(2) as Sha256),
      await repo.scheduleOrphan(own, shaOf(3) as Sha256),
    ];
    const after = await context.executor.all<{ id: string; purge_after: string | null }>({
      sql: 'SELECT id, purge_after FROM blob ORDER BY id',
      params: [],
    });
    expect(scheduled).toEqual([true, true, true]);
    expect(after.filter((row) => row.purge_after !== null).map((row) => row.id)).toEqual([
      'B-ING',
      'B-OWN',
      'B-UP',
    ]);
  },
};

const orphanEntry: MutationEntry = {
  builder: 'blobOrphanCondition',
  file: 'repositories/blob-references.ts',
  cases: [orphansScheduledWithinOrganization],
  waivers: [
    {
      locate: /"org_id" = \?/,
      reason:
        'the appended eligibility condition repeats the organization predicate, so no case can tell this copy from its twin',
    },
    {
      locate: /\(blob\.org_id = \?|\b(?:bref_\w+|blob)\.org_id = (?:blob|bref_\w+)\.org_id/,
      reason:
        'the appended eligibility condition is the blobEligibleCondition fragment, whose organization joins are judged by that entry',
    },
  ],
  predicates: [
    {
      name: 'an ingest session is scoped to the blob organization',
      locate: /bref_ing\.org_id = blob\.org_id/,
      neutral: ALWAYS,
      caseName: orphansScheduledWithinOrganization.name,
      copies: 6,
      waivedCopies: { 0: UNRELATED_COPY, 1: UNRELATED_COPY, 4: UNRELATED_COPY, 5: UNRELATED_COPY },
    },
    {
      name: 'an upstream state is scoped to the blob organization',
      locate: /bref_up\.org_id = blob\.org_id/,
      neutral: ALWAYS,
      caseName: orphansScheduledWithinOrganization.name,
      copies: 6,
      waivedCopies: { 0: UNRELATED_COPY, 1: UNRELATED_COPY, 2: UNRELATED_COPY, 3: UNRELATED_COPY },
    },
  ],
};

type ReleaseKind = 'tombstoned' | 'version' | 'package';

interface PrematureOptions {
  readonly purgeAfter?: string;
  readonly override?: number;
  readonly status?: 'active';
}

function prematureCase(
  kind: ReleaseKind,
  releasedAt: string,
  premature: boolean,
  options: PrematureOptions = {},
): ContractCase {
  const purgeAfter = options.purgeAfter ?? '2026-10-02T00:00:00.000Z';
  const label = [
    options.override === undefined ? '' : ` with a source override of ${String(options.override)}`,
    options.status === undefined ? '' : ' on an active version',
  ].join('');
  return {
    name: `a ${kind} release at ${releasedAt}${label} makes a schedule at ${purgeAfter.slice(0, 10)} ${premature ? '' : 'not '}premature`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      for (const [id, sha] of [
        ['B', '1'],
        ['BR', '2'],
      ] as const) {
        await seedBlobRow(seed, id, own.orgId, sha.repeat(64));
      }
      await seed('UPDATE blob SET purge_after = ?', purgeAfter);
      await seed(
        'UPDATE organization SET retention_removed_upstream_days = 1 WHERE id = ?',
        foreign.orgId,
      );
      await seedSource(seed, 'S', foreign.orgId, 'vcs');
      if (options.override !== undefined) {
        await seed('UPDATE source SET retention_days_override = ?', options.override);
      }
      await seedPackage(seed, 'K', foreign.orgId, 'S', 'acme/pkg');
      const [status, tombstoned, removed] =
        options.status === 'active'
          ? ['active', null, null]
          : kind === 'tombstoned'
            ? ['tombstoned', releasedAt, null]
            : kind === 'version'
              ? ['removed_upstream', null, releasedAt]
              : ['tombstoned', OLD, null];
      for (const [id, direct] of [
        ['V', 'B'],
        ['VR', null],
      ] as const) {
        await seed(
          `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at, removed_upstream_at)
            VALUES (?, ?, 'K', ?, ?, ?, 'upstream', '{}', ?, ?, ?, ?)`,
          id,
          foreign.orgId,
          id,
          id,
          OLD,
          direct,
          status,
          tombstoned,
          removed,
        );
      }
      await seed(
        "INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) VALUES ('REV', ?, 'VR', 1, 'BR', '{}', 'test')",
        foreign.orgId,
      );
      if (kind === 'package') {
        await seed(
          "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'K'",
          releasedAt,
        );
      }
      const condition = blobPrematureCondition(own, 'b');
      const rows = await context.executor.all(
        context.mutate({
          sql: `SELECT b.id FROM blob b WHERE ${condition.sql} ORDER BY b.id`,
          params: condition.params,
        }),
      );
      expect(rows).toEqual(premature ? [{ id: 'B' }, { id: 'BR' }] : []);
    },
  };
}

const RELEASED = '2026-10-01T00:00:00.000Z';
const prematureCases = [
  ...(['tombstoned', 'version', 'package'] as const).map((kind) =>
    prematureCase(kind, RELEASED, true),
  ),
  prematureCase('tombstoned', OLD, false),
  prematureCase('tombstoned', OLD, true, { purgeAfter: '2021-06-01T00:00:00.000Z', override: 730 }),
  prematureCase('tombstoned', OLD, false, { purgeAfter: '2021-06-01T00:00:00.000Z' }),
  prematureCase('tombstoned', OLD, false, { status: 'active' }),
];
const overrideCase = prematureCases[4] as ContractCase;
const activeCase = prematureCases[6] as ContractCase;
const prematureCaseOf = (kind: ReleaseKind) =>
  prematureCases.find((found) => found.name.includes(`a ${kind} release at ${RELEASED}`)) ??
  prematureCases[0]!;

const prematureEntry: MutationEntry = {
  builder: 'blobPrematureCondition',
  file: 'repositories/blob-references.ts',
  cases: prematureCases,
  predicates: [],
  sqlDecisions: [
    {
      name: 'the schedule is compared with the release time, not the other way round',
      pattern: /\.purge_after < COALESCE\(strftime/,
      replacement: '.purge_after > COALESCE(strftime',
      expected: 1,
      case: prematureCaseOf('tombstoned'),
    },
    {
      name: 'the organization retention is added to the release time',
      pattern: /'\+' \|\|/,
      replacement: "'-' ||",
      expected: 1,
      case: prematureCaseOf('tombstoned'),
    },
    {
      name: 'a tombstoned version counts at its tombstone time',
      pattern: /bref_v\.status = 'tombstoned'/,
      replacement: "bref_v.status = 'none'",
      expected: 2,
      case: prematureCaseOf('tombstoned'),
    },
    {
      name: 'a removed version counts at its removal time',
      pattern: /bref_v\.status = 'removed_upstream'/,
      replacement: "bref_v.status = 'none'",
      expected: 2,
      case: prematureCaseOf('version'),
    },
    {
      name: 'the source override can extend the retention of a reference',
      pattern: /COALESCE\(bref_s\.retention_days_override, 0\)/,
      replacement: '0',
      expected: 2,
      case: overrideCase,
    },
    {
      name: 'a version that is not released has no release time',
      pattern: /bref_rel\.rel <> ''/,
      replacement: '1 = 1',
      expected: 1,
      case: activeCase,
    },
    {
      name: 'a removed package counts at its removal time',
      pattern: /bref_p\.status = 'removed_upstream'/,
      replacement: "bref_p.status = 'none'",
      expected: 2,
      case: prematureCaseOf('package'),
    },
  ],
};

export const entries: readonly MutationEntry[] = [blobEntry, orphanEntry, prematureEntry];
