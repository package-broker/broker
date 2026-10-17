import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import {
  catalogueWriteGuard,
  type CatalogueWriteGuard,
  type VersionInput,
  type SyncResult,
} from '@package-broker/core/db/catalogue';
import {
  normalizeVersionMetadata,
  type NormalizedMetadata,
} from '@package-broker/core/catalogue/metadata';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import {
  MAX_VERSIONS_PER_CALL,
  versionInsertStatements,
  type VersionInsertPlan,
} from './catalogue-write-version-insert.js';

const JOB_ID = '01J0JOB00000000000000000C1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0C01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000S01';
const PACKAGE = '01J0PKG0000000000000000K01';
const NPM_SOURCE = '01J0SRC0000000000000000S02';
const NPM_PACKAGE = '01J0PKG0000000000000000K02';
const HISTORY = '2020-05-06T07:08:09.010Z';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let guard: CatalogueWriteGuard;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
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
  ]);
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
});

afterEach(async () => {
  await database.close();
});

const composerMeta = (extra: Record<string, unknown> = {}): NormalizedMetadata =>
  normalizeVersionMetadata('composer', {
    name: 'acme/widget',
    license: ['MIT'],
    dist: { type: 'zip', url: 'https://example.test/w.zip', shasum: 'a'.repeat(40) },
    ...extra,
  });

const composerInput = (
  version: string,
  normalized: string,
  overrides: Partial<VersionInput> = {},
): VersionInput => ({
  version,
  versionNormalized: normalized,
  history: { at: HISTORY, basis: 'release_date' },
  license: '["MIT"]',
  upstreamReleasedAt: HISTORY,
  distType: 'zip',
  sourceRef: null,
  metadata: composerMeta(),
  ...overrides,
});

interface VersionRow {
  version: string;
  normalized: string;
  stability: string;
  publishedAt: string;
  basis: string;
  license: string | null;
  shasum: string | null;
  upstreamReleasedAt: string | null;
  distType: string | null;
  sourceRef: string | null;
  deprecatedMessage: string | null;
  status: string;
  opId: string | null;
}

async function versions(packageId = PACKAGE): Promise<VersionRow[]> {
  return database.executor.all<VersionRow>({
    sql: `SELECT version, version_normalized AS normalized, stability, published_at AS publishedAt,
            published_at_basis AS basis, license, composer_shasum AS shasum, status,
            upstream_released_at AS upstreamReleasedAt, dist_type AS distType,
            source_ref AS sourceRef, deprecated_message AS deprecatedMessage, last_op_id AS opId
          FROM version WHERE package_id = ? ORDER BY version_normalized`,
    params: [packageId],
  });
}

async function pkg(id = PACKAGE): Promise<{ rev: number; modifiedAt: string }> {
  const rows = await database.executor.all<{ rev: number; modifiedAt: string }>({
    sql: 'SELECT rev, modified_at AS modifiedAt FROM package WHERE id = ?',
    params: [id],
  });
  const row = rows[0];
  if (row === undefined) throw new Error('package missing');
  return row;
}

async function run(
  inputs: readonly VersionInput[],
  using: CatalogueWriteGuard = guard,
  ecosystem: 'composer' | 'npm' = 'composer',
  packageId = PACKAGE,
): Promise<VersionInsertPlan & { outcome: SyncResult }> {
  const plan = versionInsertStatements(org, using, { packageId, ecosystem, versions: inputs });
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  const results = plan.statements.length > 0 ? await database.executor.batch(plan.statements) : [];
  return { ...plan, outcome: plan.result(results) };
}

const markListed = (at = '2021-01-01T00:00:00.000Z') =>
  database.executor.batch([
    stmt('UPDATE package SET last_synced_at = ? WHERE id = ?', at, PACKAGE),
  ]);

describe('versionInsertStatements', () => {
  it('1: before the first listing, versions take the upstream date and basis', async () => {
    await run([composerInput('1.0.0', '1.0.0.0')]);
    expect(await versions()).toMatchObject([
      { version: '1.0.0', normalized: '1.0.0.0', publishedAt: HISTORY, basis: 'release_date' },
    ]);
  });

  it('1: after last_synced_at is set, versions take database time and basis broker', async () => {
    await markListed();
    const start = Date.now();
    await run([composerInput('1.0.0', '1.0.0.0')]);
    const row = (await versions())[0];
    expect(row?.basis).toBe('broker');
    const at = Date.parse(row?.publishedAt ?? '');
    expect(at).toBeGreaterThanOrEqual(start - 5);
    expect(at).toBeLessThanOrEqual(Date.now() + 5);
  });

  it('1: the phase is decided per package', async () => {
    await markListed();
    await run([composerInput('1.0.0', '1.0.0.0')]);
    await run(
      [
        {
          ...composerInput('1.0.0', '1.0.0'),
          metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
          distType: null,
        },
      ],
      guard,
      'npm',
      NPM_PACKAGE,
    );
    expect((await versions())[0]?.basis).toBe('broker');
    expect((await versions(NPM_PACKAGE))[0]).toMatchObject({
      basis: 'release_date',
      publishedAt: HISTORY,
    });
  });

  it('1: every version of a batch before the first listing takes its own upstream date', async () => {
    const earlier = '2019-02-03T04:05:06.007Z';
    await run([
      composerInput('1.0.0', '1.0.0.0'),
      composerInput('1.1.0', '1.1.0.0', { history: { at: earlier, basis: 'release_date' } }),
    ]);
    expect((await versions()).map((v) => [v.basis, v.publishedAt])).toEqual([
      ['release_date', HISTORY],
      ['release_date', earlier],
    ]);
  });

  it('stores licence, stability, digests and the op id', async () => {
    const plan = await run([
      composerInput('1.0.0', '1.0.0.0'),
      composerInput('2.0.0-beta1', '2.0.0.0-beta1'),
      composerInput('dev-main', 'dev-main'),
    ]);
    const rows = await versions();
    expect(rows.map((r) => [r.normalized, r.stability])).toEqual([
      ['1.0.0.0', 'stable'],
      ['2.0.0.0-beta1', 'beta'],
      ['dev-main', 'dev'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ license: '["MIT"]', shasum: 'a'.repeat(40), opId: plan.opId });
    }
  });

  it('stores upstream release, dist type, source reference and deprecation independently', async () => {
    const upstreamReleasedAt = '2018-01-02T03:04:05.006Z';
    await run([
      composerInput('1.0.0', '1.0.0.0', {
        upstreamReleasedAt,
        sourceRef: 'abc123',
        metadata: { ...composerMeta(), deprecatedMessage: 'Use version 2' },
      }),
      composerInput('2.0.0', '2.0.0.0', {
        upstreamReleasedAt: null,
        distType: null,
      }),
    ]);
    expect(await versions()).toMatchObject([
      {
        upstreamReleasedAt,
        distType: 'zip',
        sourceRef: 'abc123',
        deprecatedMessage: 'Use version 2',
      },
      { upstreamReleasedAt: null, distType: null, sourceRef: null, deprecatedMessage: null },
    ]);
  });

  it('refuses later duplicate normalized identities without counting them unchanged', async () => {
    const plan = await run([
      composerInput('1.0.0', '1.0.0.0', { license: 'MIT' }),
      composerInput('v1.0.0', '1.0.0.0', { license: 'Apache-2.0' }),
      composerInput('1.0.0', '1.0.0.0'),
    ]);
    expect(plan.outcome).toMatchObject({
      inserted: 1,
      unchanged: 0,
      refused: [
        { version: 'v1.0.0', reason: 'invalid' },
        { version: '1.0.0', reason: 'invalid' },
      ],
    });
    expect(await versions()).toMatchObject([{ version: '1.0.0', license: 'MIT' }]);
    expect(await versions()).toHaveLength(1);
  });

  it.each([
    ['license', 256],
    ['sourceRef', 512],
  ] as const)('bounds %s by UTF-8 bytes', async (field, limit) => {
    const plan = await run([
      composerInput('1.0.0', '1.0.0.0', { [field]: 'é'.repeat(limit / 2) }),
      composerInput('2.0.0', '2.0.0.0', { [field]: 'é'.repeat(limit / 2) + 'a' }),
    ]);
    expect(plan.outcome).toMatchObject({
      inserted: 1,
      unchanged: 0,
      refused: [{ version: '2.0.0', reason: 'invalid' }],
    });
    expect((await versions())[0]?.[field]).toBe('é'.repeat(limit / 2));
  });

  it.each(['license', 'sourceRef'] as const)('refuses controls and non-text %s', async (field) => {
    const values = ['a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b', 7];
    const plan = await run(
      values.map((value, i) =>
        composerInput(`1.0.${String(i)}`, `1.0.${String(i)}.0`, { [field]: value }),
      ),
    );
    expect(plan.refused).toEqual(
      values.map((_value, i) => ({
        version: `1.0.${String(i)}`,
        reason: 'invalid',
      })),
    );
    expect(plan.statements).toEqual([]);
    expect(await versions()).toEqual([]);
    expect((await pkg()).rev).toBe(1);
  });

  it('stores npm stability and integrity', async () => {
    const integrity = `sha512-${'A'.repeat(86)}==`;
    await run(
      [
        {
          ...composerInput('1.0.0-rc.1', '1.0.0-rc.1'),
          distType: 'tgz',
          license: 'MIT',
          metadata: normalizeVersionMetadata('npm', {
            name: 'widget',
            license: 'MIT',
            dist: { tarball: 'https://example.test/w.tgz', integrity },
          }),
        },
      ],
      guard,
      'npm',
      NPM_PACKAGE,
    );
    const rows = await database.executor.all<{ stability: string; license: string; ni: string }>({
      sql: 'SELECT stability, license, npm_integrity AS ni FROM version WHERE package_id = ?',
      params: [NPM_PACKAGE],
    });
    expect(rows).toEqual([{ stability: 'RC', license: 'MIT', ni: integrity }]);
  });

  it('bumps package rev once per batch and advances modified_at', async () => {
    const before = await pkg();
    await run([composerInput('1.0.0', '1.0.0.0'), composerInput('1.1.0', '1.1.0.0')]);
    const after = await pkg();
    expect(after.rev).toBe(before.rev + 1);
    expect(after.modifiedAt > before.modifiedAt).toBe(true);
  });

  it('2: a replay inserts nothing and does not bump rev', async () => {
    await run([composerInput('1.0.0', '1.0.0.0')]);
    const before = { rows: await versions(), pkg: await pkg() };
    await markListed();
    const replay = await run([
      composerInput('1.0.0', '1.0.0.0', {
        history: { at: '2019-01-01T00:00:00.000Z', basis: 'release_date' },
      }),
    ]);
    expect(replay.outcome).toMatchObject({ inserted: 0, unchanged: 1, refused: [] });
    const rows = await versions();
    expect(rows).toEqual(before.rows);
    expect(await pkg()).toMatchObject({ rev: before.pkg.rev });
  });

  it('2: a tombstoned slot is never reused', async () => {
    await run([composerInput('1.0.0', '1.0.0.0')]);
    await database.executor.batch([
      stmt("UPDATE version SET status = 'tombstoned', tombstoned_at = '2020-01-01T00:00:00.000Z'"),
    ]);
    const before = { rows: await versions(), pkg: await pkg() };
    const replay = await run([composerInput('1.0.0', '1.0.0.0', { sourceRef: 'changed' })]);
    expect(replay.outcome).toMatchObject({ inserted: 0, unchanged: 1, refused: [] });
    expect(await versions()).toEqual(before.rows);
    expect((await versions())[0]?.status).toBe('tombstoned');
    expect(await pkg()).toEqual(before.pkg);
  });

  it('2: a mixed batch bumps rev once and writes only the new version', async () => {
    await run([composerInput('1.0.0', '1.0.0.0')]);
    const before = await pkg();
    const mixed = await run([composerInput('1.0.0', '1.0.0.0'), composerInput('1.1.0', '1.1.0.0')]);
    expect(mixed.outcome).toMatchObject({ inserted: 1, unchanged: 1, refused: [] });
    expect((await versions()).map((v) => v.normalized)).toEqual(['1.0.0.0', '1.1.0.0']);
    expect((await pkg()).rev).toBe(before.rev + 1);
  });

  it('3: no compiled statement updates published_at', () => {
    const plan = versionInsertStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [composerInput('1.0.0', '1.0.0.0')],
    });
    for (const s of plan.statements) {
      if (/^\s*update\b/i.test(s.sql)) expect(s.sql).not.toMatch(/published_at/i);
      expect(s.sql).not.toMatch(/do\s+update/i);
    }
    expect(plan.statements.some((s) => /insert\s+into\s+"?version"?/i.test(s.sql))).toBe(true);
  });

  it('3: a future history date fails the batch and writes nothing', async () => {
    const plan = versionInsertStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [
        composerInput('1.0.0', '1.0.0.0'),
        composerInput('1.1.0', '1.1.0.0', {
          history: { at: '2099-01-01T00:00:00.000Z', basis: 'release_date' },
        }),
      ],
    });
    await expect(database.executor.batch(plan.statements)).rejects.toThrow();
    expect(await versions()).toEqual([]);
    expect((await pkg()).rev).toBe(1);
  });

  it('3: a future history date is harmless after the first listing', async () => {
    await markListed();
    await run([
      composerInput('1.0.0', '1.0.0.0', {
        history: { at: '2099-01-01T00:00:00.000Z', basis: 'release_date' },
      }),
    ]);
    expect((await versions())[0]?.basis).toBe('broker');
  });

  it('refuses invalid identities and oversized metadata without writing them', async () => {
    const oversized: NormalizedMetadata = {
      ...composerMeta(),
      json: JSON.stringify({ pad: 'x'.repeat(262144) }),
    };
    const plan = await run([
      composerInput('1.0.0', '1.0.0.0'),
      composerInput('1.0.0', '2.0.0.0'),
      composerInput('3.0.0', '3.0.0.0', { metadata: oversized }),
      composerInput('4.0.0', '4.0.0.0', { history: { at: '2020-05-06', basis: 'release_date' } }),
      composerInput('5.0.0', '5.0.0.0', { history: { at: HISTORY, basis: 'broker' as never } }),
    ]);
    expect((await versions()).map((v) => v.normalized)).toEqual(['1.0.0.0']);
    expect(plan.refused.map((r) => [r.version, r.reason])).toEqual([
      ['1.0.0', 'invalid'],
      ['3.0.0', 'too_large'],
      ['4.0.0', 'invalid'],
      ['5.0.0', 'invalid'],
    ]);
  });

  it('builds no statements when every input is refused', () => {
    const plan = versionInsertStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [composerInput('1.0.0', '9.9.9.9')],
    });
    expect(plan.statements).toEqual([]);
    expect(plan.refused).toHaveLength(1);
  });

  it('refuses more than 50 versions and empty calls before building SQL', () => {
    expect(MAX_VERSIONS_PER_CALL).toBe(50);
    const many = Array.from({ length: 51 }, (_v, i) =>
      composerInput(`1.0.${String(i)}`, `1.0.${String(i)}.0`),
    );
    expect(() =>
      versionInsertStatements(org, guard, {
        packageId: PACKAGE,
        ecosystem: 'composer',
        versions: many,
      }),
    ).toThrow(RangeError);
    expect(() =>
      versionInsertStatements(org, guard, {
        packageId: PACKAGE,
        ecosystem: 'composer',
        versions: [],
      }),
    ).toThrow(RangeError);
  });

  it('accepts exactly 50 versions within the parameter limit', async () => {
    const fifty = Array.from({ length: 50 }, (_v, i) =>
      composerInput(`1.0.${String(i)}`, `1.0.${String(i)}.0`),
    );
    await run(fifty);
    expect(await versions()).toHaveLength(50);
    expect((await pkg()).rev).toBe(2);
  });

  it('a stale job guard rolls the whole batch back', async () => {
    const stale = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 4 });
    await expect(run([composerInput('1.0.0', '1.0.0.0')], stale)).rejects.toThrow();
    expect(await versions()).toEqual([]);
    expect((await pkg()).rev).toBe(1);
  });

  it('refuses a live org A guard for an org B package before any write', async () => {
    await database.executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('foreign-source', ?, 'foreign', 'composer', 'composer_repository')",
        other.orgId,
      ),
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('foreign-package', ?, 'foreign-source', 'composer', 'acme/widget')",
        other.orgId,
      ),
    ]);
    expect(() =>
      versionInsertStatements(other, guard, {
        packageId: 'foreign-package',
        ecosystem: 'composer',
        versions: [composerInput('1.0.0', '1.0.0.0')],
      }),
    ).toThrow(TypeError);
    expect(await versions('foreign-package')).toEqual([]);
    expect((await pkg('foreign-package')).rev).toBe(1);
  });

  it('refuses unregistered and empty guards without writing', async () => {
    for (const forged of [catalogueWriteGuard([...guard]), catalogueWriteGuard([])]) {
      await expect(run([composerInput('1.0.0', '1.0.0.0')], forged)).rejects.toThrow(TypeError);
    }
    expect(await versions()).toEqual([]);
    expect((await pkg()).rev).toBe(1);
  });

  it('stores the top-level licence independently of metadata licence', async () => {
    await run([composerInput('1.0.0', '1.0.0.0', { license: 'Apache-2.0' })]);
    expect((await versions())[0]?.license).toBe('Apache-2.0');
  });

  it.each([-1, 1])('enforces the batch byte budget at 4 MiB %+i bytes', async (delta) => {
    const inputs = Array.from({ length: 17 }, (_, i) =>
      composerInput(`1.0.${String(i)}`, `1.0.${String(i)}.0`, {
        license: 'é',
        metadata: composerMeta({ description: 'x'.repeat(240_000) }),
      }),
    );
    const request = { packageId: PACKAGE, ecosystem: 'composer' as const, versions: inputs };
    const baseline = versionInsertStatements(org, guard, request);
    const bytes = baseline.statements
      .flatMap((s) => s.params)
      .reduce<number>(
        (sum, value) =>
          sum +
          (typeof value === 'string'
            ? new TextEncoder().encode(value).length
            : value instanceof Uint8Array
              ? value.byteLength
              : value === null
                ? 0
                : 8),
        0,
      );
    const padding = 4 * 1024 * 1024 + delta - bytes;
    expect(padding).toBeGreaterThan(0);
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      inputs[i] = {
        ...input,
        metadata: composerMeta({
          description: 'x'.repeat(
            240_000 + Math.floor(padding / inputs.length) + (i < padding % inputs.length ? 1 : 0),
          ),
        }),
      };
    }
    if (delta < 0) {
      const plan = await run(inputs);
      expect(plan.outcome).toMatchObject({ inserted: 17, unchanged: 0, refused: [] });
      expect(await versions()).toHaveLength(17);
    } else {
      await expect(run(inputs)).rejects.toMatchObject({ code: 'batch_too_large' });
      expect(await versions()).toEqual([]);
      expect((await pkg()).rev).toBe(1);
    }
  });

  it('refuses a package of another ecosystem or organization', async () => {
    await expect(run([composerInput('1.0.0', '1.0.0')], guard, 'npm', PACKAGE)).rejects.toThrow();
    expect(() =>
      versionInsertStatements(other, guard, {
        packageId: PACKAGE,
        ecosystem: 'composer',
        versions: [composerInput('1.0.0', '1.0.0.0')],
      }),
    ).toThrow(TypeError);
    expect(await versions()).toEqual([]);
  });
});
