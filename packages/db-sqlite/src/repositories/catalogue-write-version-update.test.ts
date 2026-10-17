import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { CatalogueWriteGuard, VersionInput } from '@package-broker/core/db/catalogue';
import {
  MAX_METADATA_BYTES,
  normalizeVersionMetadata,
} from '@package-broker/core/catalogue/metadata';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { versionInsertStatements } from './catalogue-write-version-insert.js';
import { versionUpdateStatements } from './catalogue-write-version-update.js';

const JOB_ID = '01J0JOB00000000000000000C1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0C01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000S01';
const PACKAGE = '01J0PKG0000000000000000K01';
const NPM_SOURCE = '01J0SRC0000000000000000S02';
const NPM_PACKAGE = '01J0PKG0000000000000000K02';
const BLOB = '01J0BLB0000000000000000B01';
const HISTORY = '2020-05-06T07:08:09.010Z';
const INTEGRITY_A = `sha512-${'A'.repeat(86)}==`;
const INTEGRITY_B = `sha512-${'B'.repeat(86)}==`;

let database: MigratedDatabase;
let org: OrgContext;
let guard: CatalogueWriteGuard;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  await database.executor.batch([
    stmt(
      `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
        VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
      JOB_ID,
      org.orgId,
      `k:${JOB_ID}`,
      OWNER,
      FUTURE,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
      SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
      NPM_SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', 'acme/widget')",
      PACKAGE,
      org.orgId,
      SOURCE,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'widget')",
      NPM_PACKAGE,
      org.orgId,
      NPM_SOURCE,
    ),
    stmt(
      `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key)
        VALUES (?, ?, ?, 1, 'k/blob')`,
      BLOB,
      org.orgId,
      'c'.repeat(64),
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
});

afterEach(async () => {
  await database.close();
});

const composerInput = (
  overrides: Partial<VersionInput> & { shasum?: string } = {},
): VersionInput => {
  const { shasum = 'a'.repeat(40), ...rest } = overrides;
  return {
    version: '1.0.0',
    versionNormalized: '1.0.0.0',
    history: { at: HISTORY, basis: 'release_date' },
    license: 'MIT',
    upstreamReleasedAt: HISTORY,
    distType: 'zip',
    sourceRef: 'ref-1',
    metadata: normalizeVersionMetadata('composer', {
      name: 'acme/widget',
      dist: { type: 'zip', url: 'https://example.test/w.zip', shasum },
    }),
    ...rest,
  };
};

const npmInput = (
  integrity = INTEGRITY_A,
  extra: Record<string, unknown> = {},
  overrides: Partial<VersionInput> = {},
): VersionInput => ({
  version: '1.0.0',
  versionNormalized: '1.0.0',
  history: { at: HISTORY, basis: 'release_date' },
  license: 'MIT',
  upstreamReleasedAt: HISTORY,
  distType: 'tgz',
  sourceRef: null,
  metadata: normalizeVersionMetadata('npm', {
    name: 'widget',
    license: 'MIT',
    dist: { tarball: 'https://example.test/w.tgz', integrity },
    ...extra,
  }),
  ...overrides,
});

async function seed(inputs: readonly VersionInput[], ecosystem: 'composer' | 'npm' = 'composer') {
  const packageId = ecosystem === 'composer' ? PACKAGE : NPM_PACKAGE;
  const plan = versionInsertStatements(org, guard, { packageId, ecosystem, versions: inputs });
  await database.executor.batch(plan.statements);
}

async function update(
  inputs: readonly VersionInput[],
  ecosystem: 'composer' | 'npm' = 'composer',
  using: CatalogueWriteGuard = guard,
) {
  const plan = versionUpdateStatements(org, using, {
    packageId: ecosystem === 'composer' ? PACKAGE : NPM_PACKAGE,
    ecosystem,
    versions: inputs,
  });
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  const results = await database.executor.batch(plan.statements);
  return { ...plan, outcome: plan.result(results) };
}

interface Row {
  revision: number;
  metadataJson: string;
  sourceRef: string | null;
  distType: string | null;
  license: string | null;
  shasum: string | null;
  integrity: string | null;
  blobId: string | null;
  deprecated: string | null;
  upstream: string | null;
  publishedAt: string;
  opId: string | null;
}

async function row(packageId = PACKAGE): Promise<Row> {
  const rows = await database.executor.all<Row>({
    sql: `SELECT revision, metadata_json AS metadataJson, source_ref AS sourceRef,
            dist_type AS distType, license, composer_shasum AS shasum,
            npm_integrity AS integrity, blob_id AS blobId, deprecated_message AS deprecated,
            upstream_released_at AS upstream, published_at AS publishedAt, last_op_id AS opId
          FROM version WHERE package_id = ?`,
    params: [packageId],
  });
  const found = rows[0];
  if (found === undefined) throw new Error('version missing');
  return found;
}

const revisions = () =>
  database.executor.all<{
    revision: number;
    metadataJson: string;
    sourceRef: string | null;
    blobId: string | null;
    reason: string;
    opId: string | null;
  }>({
    sql: `SELECT revision, metadata_json AS metadataJson, source_ref AS sourceRef,
            blob_id AS blobId, reason, op_id AS opId
          FROM version_revision ORDER BY revision`,
    params: [],
  });

async function pkgRev(id = PACKAGE): Promise<number> {
  const rows = await database.executor.all<{ rev: number }>({
    sql: 'SELECT rev FROM package WHERE id = ?',
    params: [id],
  });
  return rows[0]?.rev ?? -1;
}

describe('versionUpdateStatements', () => {
  it('1: a changed Composer version writes one before-image and increments revision once', async () => {
    await seed([composerInput()]);
    const old = await row();
    const rev = await pkgRev();
    const plan = await update([composerInput({ sourceRef: 'ref-2' })]);
    expect(plan.outcome).toMatchObject({ updated: 1, unchanged: 0, conflicts: [] });
    const after = await row();
    expect(after).toMatchObject({ revision: 2, sourceRef: 'ref-2', opId: plan.opId });
    expect(await revisions()).toEqual([
      {
        revision: 1,
        metadataJson: old.metadataJson,
        sourceRef: 'ref-1',
        blobId: null,
        reason: 'upstream_change',
        opId: plan.opId,
      },
    ]);
    expect(await pkgRev()).toBe(rev + 1);
    expect(after.publishedAt).toBe(old.publishedAt);
  });

  it('1: a replay changes nothing', async () => {
    await seed([composerInput()]);
    await update([composerInput({ sourceRef: 'ref-2' })]);
    const before = { row: await row(), revisions: await revisions(), rev: await pkgRev() };
    const replay = await update([composerInput({ sourceRef: 'ref-2' })]);
    expect(replay.outcome).toMatchObject({ updated: 0, unchanged: 1, conflicts: [] });
    expect(await row()).toEqual(before.row);
    expect(await revisions()).toEqual(before.revisions);
    expect(await pkgRev()).toBe(before.rev);
  });

  it.each([
    ['licence', { license: 'Apache-2.0' }],
    [
      'dist type',
      {
        distType: 'tar' as const,
        metadata: normalizeVersionMetadata('composer', {
          name: 'acme/widget',
          dist: { type: 'tar', url: 'https://example.test/w.zip', shasum: 'a'.repeat(40) },
        }),
      },
    ],
    ['metadata', { shasum: 'b'.repeat(40) }],
  ])('1: a changed %s is revised', async (_name, change) => {
    await seed([composerInput()]);
    await database.executor.batch([stmt('UPDATE version SET blob_id = ?', BLOB)]);
    await update([composerInput(change)]);
    if (_name === 'dist type') expect((await row()).blobId).toBeNull();
    expect((await row()).revision).toBe(2);
    expect(await revisions()).toHaveLength(1);
  });

  it('1: a changed dist resets blob_id and keeps the old blob in the before-image', async () => {
    await seed([composerInput()]);
    await database.executor.batch([stmt('UPDATE version SET blob_id = ?', BLOB)]);
    await update([composerInput({ shasum: 'b'.repeat(40) })]);
    expect(await row()).toMatchObject({ blobId: null, shasum: 'b'.repeat(40) });
    expect((await revisions())[0]?.blobId).toBe(BLOB);
  });

  it('1: an unchanged dist keeps blob_id', async () => {
    await seed([composerInput()]);
    await database.executor.batch([stmt('UPDATE version SET blob_id = ?', BLOB)]);
    await update([composerInput({ sourceRef: 'ref-2' })]);
    expect((await row()).blobId).toBe(BLOB);
  });

  it('1: deprecation and upstream date change in place without a before-image', async () => {
    await seed([composerInput()]);
    const rev = await pkgRev();
    const base = composerInput();
    const plan = await update([
      {
        ...base,
        upstreamReleasedAt: '2019-01-02T03:04:05.006Z',
        metadata: { ...base.metadata, deprecatedMessage: 'Use 2' },
      },
    ]);
    expect(plan.outcome).toMatchObject({ updated: 1, unchanged: 0 });
    expect(await row()).toMatchObject({
      revision: 1,
      deprecated: 'Use 2',
      upstream: '2019-01-02T03:04:05.006Z',
      opId: plan.opId,
    });
    expect(await revisions()).toEqual([]);
    expect(await pkgRev()).toBe(rev + 1);
  });

  it('1: a revision together with a deprecation change is one revision', async () => {
    await seed([composerInput()]);
    const base = composerInput({ sourceRef: 'ref-2' });
    await update([{ ...base, metadata: { ...base.metadata, deprecatedMessage: 'Gone' } }]);
    expect(await row()).toMatchObject({ revision: 2, deprecated: 'Gone' });
    expect(await revisions()).toHaveLength(1);
  });

  it('1: a tombstoned slot is never touched', async () => {
    await seed([composerInput()]);
    await database.executor.batch([
      stmt("UPDATE version SET status = 'tombstoned', tombstoned_at = '2020-01-01T00:00:00.000Z'"),
    ]);
    const before = { row: await row(), rev: await pkgRev() };
    const plan = await update([composerInput({ sourceRef: 'ref-2' })]);
    expect(plan.outcome).toMatchObject({ updated: 0, unchanged: 1 });
    expect(await row()).toEqual(before.row);
    expect(await revisions()).toEqual([]);
    expect(await pkgRev()).toBe(before.rev);
  });

  it('1: an absent version is left alone', async () => {
    const rev = await pkgRev();
    const plan = await update([composerInput()]);
    expect(plan.outcome).toMatchObject({ updated: 0, unchanged: 1 });
    expect(await pkgRev()).toBe(rev);
  });

  it('2: an npm manifest change is a conflict and unwritten', async () => {
    await seed([npmInput()], 'npm');
    const before = { row: await row(NPM_PACKAGE), rev: await pkgRev(NPM_PACKAGE) };
    const plan = await update([npmInput(INTEGRITY_A, { description: 'changed' })], 'npm');
    expect(plan.outcome).toMatchObject({ updated: 0, unchanged: 0, conflicts: ['1.0.0'] });
    expect(await row(NPM_PACKAGE)).toEqual(before.row);
    expect(await revisions()).toEqual([]);
    expect(await pkgRev(NPM_PACKAGE)).toBe(before.rev);
  });

  it('2: an npm integrity change is a conflict even with a deprecation change', async () => {
    await seed([npmInput()], 'npm');
    const before = await row(NPM_PACKAGE);
    const plan = await update([npmInput(INTEGRITY_B, { deprecated: 'old' })], 'npm');
    expect(plan.outcome.conflicts).toEqual(['1.0.0']);
    expect(await row(NPM_PACKAGE)).toEqual({ ...before, deprecated: 'old', opId: plan.opId });
    expect(plan.outcome).toMatchObject({ updated: 1, unchanged: 0 });
  });

  it('2: an npm deprecation change bumps package rev without a revision row', async () => {
    await seed([npmInput()], 'npm');
    const rev = await pkgRev(NPM_PACKAGE);
    const plan = await update([npmInput(INTEGRITY_A, { deprecated: 'old' })], 'npm');
    expect(plan.outcome).toMatchObject({ updated: 1, conflicts: [] });
    expect(await row(NPM_PACKAGE)).toMatchObject({
      revision: 1,
      deprecated: 'old',
      opId: plan.opId,
    });
    expect(await revisions()).toEqual([]);
    expect(await pkgRev(NPM_PACKAGE)).toBe(rev + 1);
  });

  it('2: an identical npm version is unchanged and a replay does not bump rev', async () => {
    await seed([npmInput(INTEGRITY_A, { deprecated: 'old' })], 'npm');
    const rev = await pkgRev(NPM_PACKAGE);
    const plan = await update([npmInput(INTEGRITY_A, { deprecated: 'old' })], 'npm');
    expect(plan.outcome).toMatchObject({ updated: 0, unchanged: 1, conflicts: [] });
    expect(await pkgRev(NPM_PACKAGE)).toBe(rev);
  });

  it('3: a revision CAS mismatch fails the batch and writes nothing', async () => {
    await seed([composerInput()]);
    const before = { row: await row(), rev: await pkgRev() };
    await database.executor.batch([
      stmt(
        `INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, reason)
          SELECT 'rival', org_id, id, 1, '{}', 'upstream_change' FROM version`,
      ),
    ]);
    const plan = versionUpdateStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [composerInput({ sourceRef: 'ref-2' })],
    });
    await expect(database.executor.batch(plan.statements)).rejects.toThrow();
    expect(await row()).toEqual(before.row);
    expect(await revisions()).toHaveLength(1);
    expect(await pkgRev()).toBe(before.rev);
  });

  it('3: a stale job guard fails the batch', async () => {
    await seed([composerInput()]);
    const stale = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 4 });
    const before = await row();
    await expect(
      update([composerInput({ sourceRef: 'ref-2' })], 'composer', stale),
    ).rejects.toThrow();
    expect(await row()).toEqual(before);
  });

  it('3: no compiled statement updates published_at', async () => {
    const plan = versionUpdateStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [composerInput()],
    });
    for (const s of plan.statements) {
      if (/^\s*update\b/i.test(s.sql)) expect(s.sql).not.toMatch(/published_at/i);
    }
  });

  it('refuses an invalid version without a statement for it', () => {
    const plan = versionUpdateStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [composerInput({ versionNormalized: '9.9.9.9' })],
    });
    expect(plan.statements).toEqual([]);
    expect(plan.refused).toEqual([{ version: '1.0.0', reason: 'invalid' }]);
  });

  it('refuses a guard of another organization', () => {
    const other = database.orgs?.b;
    if (other === undefined) throw new Error('organizations were not seeded');
    expect(() =>
      versionUpdateStatements(other, guard, {
        packageId: PACKAGE,
        ecosystem: 'composer',
        versions: [composerInput()],
      }),
    ).toThrow(TypeError);
  });
  it.each(['url', 'reference', 'sourceRef', 'unchanged'] as const)(
    'empty Composer shasum: %s controls blob invalidation',
    async (field) => {
      const base = composerInput({ shasum: '' });
      await seed([base]);
      await database.executor.batch([stmt('UPDATE version SET blob_id = ?', BLOB)]);
      const incoming = composerInput({
        shasum: '',
        license: 'Apache-2.0',
        sourceRef: field === 'sourceRef' ? 'ref-2' : base.sourceRef,
        metadata: normalizeVersionMetadata('composer', {
          name: 'acme/widget',
          dist: {
            type: 'zip',
            url: field === 'url' ? 'https://example.test/new.zip' : 'https://example.test/w.zip',
            shasum: '',
            ...(field === 'reference' ? { reference: 'new-ref' } : {}),
          },
        }),
      });
      await update([incoming]);
      expect((await row()).blobId).toBe(field === 'unchanged' ? BLOB : null);
      expect((await revisions())[0]?.blobId).toBe(BLOB);
    },
  );

  it.each(['composer', 'npm'] as const)(
    'replaying the same %s plan preserves both package clocks',
    async (ecosystem) => {
      const base = ecosystem === 'composer' ? composerInput() : npmInput();
      await seed([base], ecosystem);
      const incoming =
        ecosystem === 'composer'
          ? composerInput({ sourceRef: 'ref-2' })
          : npmInput(INTEGRITY_A, { deprecated: 'old' });
      const plan = await update([incoming], ecosystem);
      const snapshot = await database.executor.all(
        stmt('SELECT rev, modified_at FROM package WHERE org_id = ?', org.orgId),
      );
      const before = await row(ecosystem === 'composer' ? PACKAGE : NPM_PACKAGE);
      const result = plan.result(await database.executor.batch(plan.statements));
      expect(result).toMatchObject({ updated: 0, unchanged: 1, conflicts: [] });
      expect(
        await database.executor.all(
          stmt('SELECT rev, modified_at FROM package WHERE org_id = ?', org.orgId),
        ),
      ).toEqual(snapshot);
      expect(await row(ecosystem === 'composer' ? PACKAGE : NPM_PACKAGE)).toEqual(before);
    },
  );

  it('applies deprecation while reporting an npm manifest conflict', async () => {
    await seed([npmInput()], 'npm');
    const before = await row(NPM_PACKAGE);
    const rev = await pkgRev(NPM_PACKAGE);
    const plan = await update(
      [npmInput(INTEGRITY_A, { description: 'changed', deprecated: 'Use 2' })],
      'npm',
    );
    expect(plan.outcome).toMatchObject({ updated: 1, unchanged: 0, conflicts: ['1.0.0'] });
    expect(await row(NPM_PACKAGE)).toEqual({ ...before, deprecated: 'Use 2', opId: plan.opId });
    expect(await revisions()).toEqual([]);
    expect(await pkgRev(NPM_PACKAGE)).toBe(rev + 1);
  });

  it.each([
    'a'.repeat(1025),
    'é'.repeat(513),
    'bad\nmessage',
    'bad\u0000message',
    'bad\u0085message',
  ])('refuses an overlong or control-bearing deprecation message', (message) => {
    const plan = versionUpdateStatements(org, guard, {
      packageId: NPM_PACKAGE,
      ecosystem: 'npm',
      versions: [npmInput(INTEGRITY_A, { deprecated: message })],
    });
    expect(plan.refused).toEqual([{ version: '1.0.0', reason: 'invalid' }]);
    expect(plan.statements).toEqual([]);
  });

  it('accepts a deprecation message at the 1024-byte boundary and clears it', async () => {
    await seed([npmInput()], 'npm');
    await update([npmInput(INTEGRITY_A, { deprecated: 'é'.repeat(512) })], 'npm');
    expect((await row(NPM_PACKAGE)).deprecated).toBe('é'.repeat(512));
    await update([npmInput()], 'npm');
    expect((await row(NPM_PACKAGE)).deprecated).toBeNull();
  });

  it('rejects a package from another organization with a valid local guard', async () => {
    const other = database.orgs?.b;
    if (other === undefined) throw new Error('organizations were not seeded');
    await database.executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('other-source', ?, 'main', 'composer', 'composer_repository')",
        other.orgId,
      ),
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('other-package', ?, 'other-source', 'composer', 'acme/widget')",
        other.orgId,
      ),
    ]);
    const before = await database.executor.all(stmt('SELECT * FROM package'));
    const plan = versionUpdateStatements(org, guard, {
      packageId: 'other-package',
      ecosystem: 'composer',
      versions: [composerInput()],
    });
    await expect(database.executor.batch(plan.statements)).rejects.toThrow();
    expect(await database.executor.all(stmt('SELECT * FROM package'))).toEqual(before);
  });

  it('rejects an ecosystem mismatch', async () => {
    await seed([composerInput()]);
    const before = await row();
    const plan = versionUpdateStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'npm',
      versions: [npmInput()],
    });
    await expect(database.executor.batch(plan.statements)).rejects.toThrow();
    expect(await row()).toEqual(before);
  });

  it('counts mixed npm batches and maps conflicts to their original input versions', async () => {
    const inputs = [1, 2, 3, 4].map((n) =>
      npmInput(INTEGRITY_A, {}, { version: `${n}.0.0`, versionNormalized: `${n}.0.0` }),
    );
    await seed(inputs, 'npm');
    const rev = await pkgRev(NPM_PACKAGE);
    const incoming = inputs.map((input, index) => ({
      ...input,
      metadata: normalizeVersionMetadata('npm', {
        name: 'widget',
        license: 'MIT',
        dist: { tarball: 'https://example.test/w.tgz', integrity: INTEGRITY_A },
        ...(index === 0 || index === 2 ? { deprecated: 'old' } : {}),
        ...(index === 2 || index === 3 ? { description: 'changed' } : {}),
      }),
    }));
    const plan = await update([incoming[3]!, incoming[1]!, incoming[2]!, incoming[0]!], 'npm');
    expect(plan.outcome).toMatchObject({
      updated: 2,
      unchanged: 1,
      conflicts: ['4.0.0', '3.0.0'],
    });
    expect(await pkgRev(NPM_PACKAGE)).toBe(rev + 1);
    expect(await revisions()).toEqual([]);
  });

  it('does not increment revision when the before-image insert matches nothing', async () => {
    await seed([composerInput()]);
    const before = await row();
    const plan = await update([composerInput()]);
    expect(plan.outcome).toMatchObject({ updated: 0, unchanged: 1 });
    expect(await row()).toEqual(before);
    expect(await revisions()).toEqual([]);
  });

  it('refuses metadata exceeding the per-version byte cap', () => {
    const base = composerInput();
    const plan = versionUpdateStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [
        {
          ...base,
          metadata: {
            ...base.metadata,
            json: JSON.stringify({ description: 'x'.repeat(MAX_METADATA_BYTES) }),
          },
        },
      ],
    });
    expect(plan.refused).toEqual([{ version: '1.0.0', reason: 'too_large' }]);
    expect(plan.statements).toEqual([]);
  });

  it('rejects an oversized aggregate parameter payload', () => {
    const metadata = normalizeVersionMetadata('composer', { description: 'x'.repeat(240000) });
    const versions = Array.from({ length: 50 }, (_, index) =>
      composerInput({ version: `1.0.${index}`, versionNormalized: `1.0.${index}.0`, metadata }),
    );
    expect(() =>
      versionUpdateStatements(org, guard, { packageId: PACKAGE, ecosystem: 'composer', versions }),
    ).toThrow(expect.objectContaining({ code: 'batch_too_large' }));
  });
});
