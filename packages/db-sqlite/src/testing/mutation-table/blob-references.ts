import { orgOf, seeder, type ContractCase, type Seed, type MutationEntry } from './harness.js';
import { expect } from 'vitest';
import type { Statement } from '@package-broker/core/db/port';
import { blobEligibleCondition } from '../../repositories/blob-references.js';
import { seedSource, seedPackage, FUTURE, NOT_NULL, ALWAYS } from './fixtures.js';

const EXISTS_COPY =
  'the released check treats an inconsistent reference as unreleased, so the blob stays ineligible whatever this copy says';

const HOSTED_COPY =
  'an inconsistent reference already blocks eligibility through the released check';

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

export const entries: readonly MutationEntry[] = [blobEntry];
