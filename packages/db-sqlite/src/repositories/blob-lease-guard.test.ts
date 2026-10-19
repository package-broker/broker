import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { PurgeGeneration, Sha256 } from '@package-broker/core/platform/blob';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { blobLeaseNotLive } from './blob-lease-guard.js';
import * as leaseGuard from './blob-lease-guard.js';
import { distAttachStatements } from './catalogue-write-dist.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createBlobRepository } from './blob.js';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let counter = 0;

const digest = (n: number) => n.toString(16).padStart(64, '0');
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now'`;

beforeEach(async () => {
  counter = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

async function run(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await executor.batch([{ sql, params }]);
}

async function seedParents(org: OrgContext): Promise<void> {
  await run('INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)', [
    `S${org.orgId}`,
    org.orgId,
    's',
    'npm',
    'npmjs_proxy',
  ]);
  await run(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name, status) VALUES (?, ?, ?, ?, ?, ?)',
    [`P${org.orgId}`, org.orgId, `S${org.orgId}`, 'npm', 'p', 'active'],
  );
}

async function blob(org: OrgContext, n: number, lease: string | null): Promise<string> {
  const id = `BLOB${n}${org.orgId}`;
  await run(
    'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
    [id, org.orgId, digest(n), `k${n}${org.orgId}`],
  );
  if (lease !== null) {
    await run(`UPDATE blob SET purge_lease_until = ${NOW},'${lease}') WHERE id = ?`, [id]);
  }
  return id;
}

async function version(org: OrgContext, blobId: string | null): Promise<string> {
  counter += 1;
  const id = `VER${counter}`;
  await run(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status)
VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 'upstream', '{}', ?, 'active')`,
    [id, org.orgId, `P${org.orgId}`, `1.0.${counter}`, String(counter).padStart(5, '0'), blobId],
  );
  return id;
}

async function passes(org: OrgContext, versionId: string, alias = 'v'): Promise<boolean> {
  const guard = blobLeaseNotLive(org, alias);
  const rows = await executor.all({
    sql: `SELECT ${alias}.id FROM version ${alias} WHERE ${alias}.id = ? AND ${guard.sql}`,
    params: [versionId, ...guard.params],
  });
  return rows.length === 1;
}

describe('blobLeaseNotLive', () => {
  beforeEach(async () => {
    await seedParents(a);
    await seedParents(b);
  });

  it('passes a version without a blob', async () => {
    expect(await passes(a, await version(a, null))).toBe(true);
  });

  it('passes a version whose blob has no lease', async () => {
    expect(await passes(a, await version(a, await blob(a, 1, null)))).toBe(true);
  });

  it('blocks a version whose blob lease expires in the future', async () => {
    expect(await passes(a, await version(a, await blob(a, 1, '+900 seconds')))).toBe(false);
  });

  it('is not blocked by the live lease of a different blob', async () => {
    await blob(a, 2, '+900 seconds');
    expect(await passes(a, await version(a, await blob(a, 1, null)))).toBe(true);
  });

  it('passes a lease that expired a second ago', async () => {
    expect(await passes(a, await version(a, await blob(a, 1, '-1 seconds')))).toBe(true);
  });

  it('blocks a lease expiring one second ahead', async () => {
    expect(await passes(a, await version(a, await blob(a, 1, '+1 seconds')))).toBe(false);
  });

  it('passes a deleted blob whose lease was cleared', async () => {
    const id = await blob(a, 1, '+900 seconds');
    await run(`UPDATE blob SET deleted_at = ${NOW}), purge_lease_until = NULL WHERE id = ?`, [id]);
    expect(await passes(a, await version(a, id))).toBe(true);
  });

  it('binds exactly the organization id', () => {
    expect(blobLeaseNotLive(a, 'v').params).toEqual([a.orgId]);
  });

  it('ignores a live lease on a blob of another organization', async () => {
    const foreign = await blob(b, 1, '+900 seconds');
    expect(await passes(a, await version(a, foreign))).toBe(true);
  });

  it('interpolates only the validated alias', () => {
    const fragment = blobLeaseNotLive(a, 'ver_1');
    expect(fragment.sql.replaceAll('ver_1', 'ALIAS')).toBe(
      blobLeaseNotLive(a, 'other').sql.replaceAll('other', 'ALIAS'),
    );
    expect(fragment.sql).not.toContain(a.orgId);
  });

  it.each(['bref_v', 'bls_blob', 'BLS_BLOB', '', 'a b', 'x;--'])(
    'rejects alias %j without executing anything',
    async (alias) => {
      const spy = vi.spyOn(executor, 'all');
      expect(() => blobLeaseNotLive(a, alias)).toThrow(TypeError);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('agrees with claimPurge for null, expired and future leases', async () => {
    const repo = createBlobRepository(executor);
    for (const [i, lease] of [null, '-1 seconds', '+900 seconds'].entries()) {
      const n = i + 10;
      const id = await blob(a, n, lease);
      await run(`UPDATE blob SET purge_after = ${NOW},'-1 days') WHERE id = ?`, [id]);
      const guarded = await passes(a, await version(a, id));
      const claimable = (await repo.claimPurge(a, digest(n) as Sha256)) !== null;
      expect(guarded).toBe(claimable);
      expect(guarded).toBe(lease !== '+900 seconds');
    }
  });

  it('agrees with leaseLive and canStartRemove when the lease equals database now', async () => {
    const now = '2026-10-17T12:00:00.000Z';
    const freeze = (statement: Statement): Statement => ({
      ...statement,
      sql: statement.sql.replaceAll("'now'", `'${now}'`),
    });
    const realExecutor = executor;
    executor = {
      driver: realExecutor.driver,
      all: (statement) => realExecutor.all(freeze(statement)),
      batch: (statements) => realExecutor.batch(statements.map(freeze)),
    };
    const repo = createBlobRepository(executor);
    const key = digest(20) as Sha256;
    const generation = 'a'.repeat(32) as PurgeGeneration;
    const id = await blob(a, 20, null);
    await run(
      'UPDATE blob SET purge_lease_until = ?, purge_generation = ?, purge_after = ? WHERE org_id = ? AND id = ?',
      [now, generation, '2026-10-16T12:00:00.000Z', a.orgId, id],
    );

    const guarded = await passes(a, await version(a, id));
    const removable = await repo.canStartRemove(a, key, generation, 0);
    const claimable = (await repo.claimPurge(a, key)) !== null;

    expect(guarded).toBe(true);
    expect(removable).toBe(false);
    expect(claimable).toBe(true);
    expect(guarded).toBe(!removable);
    expect(guarded).toBe(claimable);
  });
});

describe('dist writer shared purge lease boundary', () => {
  it.each([
    ['one tick before', '2026-10-17T11:59:59.999Z', true],
    ['equal to now', '2026-10-17T12:00:00.000Z', true],
    ['one tick after', '2026-10-17T12:00:00.001Z', false],
  ] as const)('attach handles a lease %s', async (_label, lease, available) => {
    const shared = vi.spyOn(leaseGuard, 'leaseLive');
    try {
      const freeze = (statement: Statement): Statement => ({
        ...statement,
        sql: statement.sql.replaceAll("'now'", "'2026-10-17T12:00:00.000Z'"),
      });
      const realExecutor = executor;
      executor = {
        driver: realExecutor.driver,
        all: (statement) => realExecutor.all(freeze(statement)),
        batch: (statements) => realExecutor.batch(statements.map(freeze)),
      };
      await seedParents(a);
      const id = await blob(a, 30, null);
      const versionId = await version(a, null);
      await run('UPDATE blob SET purge_lease_until = ? WHERE org_id = ? AND id = ?', [
        lease,
        a.orgId,
        id,
      ]);
      await run(
        `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
        VALUES ('boundary-job', ?, 'catalogue:sync:v1', 'boundary', 'running', 'owner', '2099-01-01T00:00:00.000Z', 3)`,
        [a.orgId],
      );
      const guard = createCatalogueWriteGuard(a, { id: 'boundary-job', owner: 'owner', fence: 3 });
      const plan = distAttachStatements(a, guard, {
        versionId,
        revision: 1,
        sha256: digest(30) as Sha256,
      });
      if (available) {
        const results = await executor.batch(plan.statements);
        expect(plan.result(results).changed).toBe(true);
      } else {
        await expect(executor.batch(plan.statements)).rejects.toThrow();
      }
      expect(shared).toHaveBeenCalledWith('blob.purge_lease_until');
      const stored = await executor.all<{ blob_id: string | null }>({
        sql: 'SELECT blob_id FROM version WHERE org_id = ? AND id = ?',
        params: [a.orgId, versionId],
      });
      expect(stored[0]?.blob_id).toBe(available ? id : null);
    } finally {
      shared.mockRestore();
    }
  });
});
