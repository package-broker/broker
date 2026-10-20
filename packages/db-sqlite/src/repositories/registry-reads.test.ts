import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createRegistryReads } from './registry-reads.js';

let database: MigratedDatabase;
let ctx: OrgContext;
let other: OrgContext;
const seen: ScalarStatement[] = [];

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

function reads() {
  const executor: ScalarSqlExecutor = {
    all: async (statement) => {
      seen.push(statement);
      return database.executor.all(statement);
    },
    batch: (statements) => database.executor.batch(statements),
  } as ScalarSqlExecutor;
  return createRegistryReads(executor);
}

async function source(
  id: string,
  options: { org?: OrgContext; ecosystem?: string; type?: string; policy?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES (?, ?, ?, ?, ?, ?)',
    [
      id,
      (options.org ?? ctx).orgId,
      id,
      options.ecosystem ?? 'composer',
      options.type ?? 'vcs',
      options.policy ?? 'flag',
    ],
  );
}

async function name(
  id: string,
  sourceId: string,
  pattern: string,
  options: { org?: OrgContext; ecosystem?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
    [id, (options.org ?? ctx).orgId, sourceId, options.ecosystem ?? 'composer', pattern],
  );
}

async function pkg(id: string, sourceId: string, packageName: string, org = ctx): Promise<void> {
  await exec(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    [id, org.orgId, sourceId, 'composer', packageName],
  );
}

async function version(id: string, packageId: string, status = 'active', org = ctx): Promise<void> {
  const normalized = `${id}.0`;
  await exec(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                          published_at_basis, metadata_json, status, removed_upstream_at, tombstoned_at)
     VALUES (?, ?, ?, '1.2.3', ?, '2020-01-01T00:00:00.000Z', 'import_time', '{}', ?, ?, ?)`,
    [
      id,
      org.orgId,
      packageId,
      normalized,
      status,
      status === 'removed_upstream' ? '2020-01-01T00:00:00.000Z' : null,
      status === 'tombstoned' ? '2020-01-01T00:00:00.000Z' : null,
    ],
  );
}

beforeEach(async () => {
  seen.length = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = database.orgs.a;
  other = database.orgs.b;
});

afterEach(async () => {
  await database.close();
});

describe('versionById', () => {
  beforeEach(async () => {
    await source('S1');
    await pkg('K1', 'S1', 'acme/widget');
    await version('V1', 'K1');
  });

  it('returns the package name and version of the row', async () => {
    expect(await reads().versionById(ctx, { packageId: 'K1', versionId: 'V1' })).toEqual({
      packageName: 'acme/widget',
      version: '1.2.3',
    });
  });

  it('returns null for another organization', async () => {
    expect(await reads().versionById(other, { packageId: 'K1', versionId: 'V1' })).toBeNull();
  });

  it('returns null for an absent version and for a version of a different package', async () => {
    await pkg('K2', 'S1', 'acme/other');
    const r = reads();
    expect(await r.versionById(ctx, { packageId: 'K1', versionId: 'NOPE' })).toBeNull();
    expect(await r.versionById(ctx, { packageId: 'K2', versionId: 'V1' })).toBeNull();
  });

  it('does not join a package of another organization', async () => {
    await source('SF', { org: other });
    await pkg('KF', 'SF', 'acme/widget', other);
    await version('VF', 'KF', 'active', other);
    expect(await reads().versionById(ctx, { packageId: 'KF', versionId: 'VF' })).toBeNull();
    expect(await reads().versionById(other, { packageId: 'KF', versionId: 'VF' })).toEqual({
      packageName: 'acme/widget',
      version: '1.2.3',
    });
  });

  it.each(['tombstoned', 'quarantined', 'yanked'])(
    'returns null for a %s version',
    async (status) => {
      await version(`V-${status}`, 'K1', status);
      expect(
        await reads().versionById(ctx, { packageId: 'K1', versionId: `V-${status}` }),
      ).toBeNull();
    },
  );

  it('serves a removed_upstream version only while the source flags removals', async () => {
    await exec(
      "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'V1'",
      ['2020-01-01T00:00:00.000Z'],
    );
    const input = { packageId: 'K1', versionId: 'V1' };
    expect(await reads().versionById(ctx, input)).not.toBeNull();
    await exec("UPDATE source SET removal_policy = 'exclude' WHERE id = 'S1'");
    expect(await reads().versionById(ctx, input)).toBeNull();
  });

  it('binds at most 100 parameters', async () => {
    await reads().versionById(ctx, { packageId: 'K1', versionId: 'V1' });
    expect(seen.length).toBeGreaterThan(0);
    for (const statement of seen) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});

describe('covers', () => {
  it('matches exact and wildcard names of the source', async () => {
    await source('S1');
    await name('R1', 'S1', 'acme/*');
    await name('R2', 'S1', 'solo/exact');
    const r = reads();
    expect(await r.covers(ctx, 'S1', 'acme/anything')).toBe(true);
    expect(await r.covers(ctx, 'S1', 'solo/exact')).toBe(true);
    expect(await r.covers(ctx, 'S1', 'solo/exact2')).toBe(false);
    expect(await r.covers(ctx, 'S1', 'beta/x')).toBe(false);
  });

  it('is scoped to the source', async () => {
    await source('S1');
    await source('S2');
    await name('R1', 'S1', 'acme/*');
    expect(await reads().covers(ctx, 'S2', 'acme/a')).toBe(false);
  });

  it('uses the ecosystem of the source', async () => {
    await source('S1', { ecosystem: 'npm', type: 'npm_registry' });
    await name('R1', 'S1', 'acme/*', { ecosystem: 'composer' });
    await name('R2', 'S1', '@scope/*', { ecosystem: 'npm' });
    const r = reads();
    expect(await r.covers(ctx, 'S1', 'acme/a')).toBe(false);
    expect(await r.covers(ctx, 'S1', '@scope/a')).toBe(true);
  });

  it('is false for an absent source and for a source of another organization', async () => {
    await source('SF', { org: other });
    await name('RF', 'SF', 'acme/*', { org: other });
    const r = reads();
    expect(await r.covers(other, 'SF', 'acme/a')).toBe(true);
    expect(await r.covers(ctx, 'SF', 'acme/a')).toBe(false);
    expect(await r.covers(ctx, 'NOPE', 'acme/a')).toBe(false);
  });

  it('ignores a registered name of another organization on the same source id', async () => {
    await source('S1');
    await name('RF', 'S1', 'acme/*', { org: other });
    expect(await reads().covers(ctx, 'S1', 'acme/a')).toBe(false);
  });

  it('never lets an invalid stored pattern cover a key', async () => {
    await source('S1');
    await name('R1', 'S1', 'acme/a b*');
    await name('R2', 'S1', `acme/${'a'.repeat(50)}*`);
    await name('R3', 'S1', 'acme/*/*/*/*/*/*/*');
    const r = reads();
    expect(await r.covers(ctx, 'S1', 'acme/a bc')).toBe(false);
    expect(await r.covers(ctx, 'S1', `acme/${'a'.repeat(60)}`)).toBe(false);
    expect(await r.covers(ctx, 'S1', 'acme/a/b/c/d/e/f/g/h/i/j/k/l/m')).toBe(false);
  });

  it('answers over many registered names with a bounded parameter count', async () => {
    await source('S1');
    await exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern)
       SELECT 'R' || i, ?, 'S1', 'composer', 'vendor' || i || '/*' FROM n`,
      [500, ctx.orgId],
    );
    const r = reads();
    expect(await r.covers(ctx, 'S1', 'vendor437/pkg')).toBe(true);
    expect(await r.covers(ctx, 'S1', 'vendor501/pkg')).toBe(false);
    for (const statement of seen) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});
