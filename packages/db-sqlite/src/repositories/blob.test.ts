import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  BlobBusyError,
  BlobConflictError,
  BlobValidationError,
  type PurgeGeneration,
  type Sha256,
} from '@package-broker/core/platform/blob';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createBlobRepository } from './blob.js';
import * as leaseGuard from './blob-lease-guard.js';

const D1 = 'a'.repeat(64) as Sha256;
const D2 = 'b'.repeat(64) as Sha256;
const TOKEN = /^[0-9a-f]{32}$/;
const GEN = TOKEN;

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

async function rows<R>(sql: string, ...params: (string | number)[]): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

async function exec(sql: string, ...params: (string | number | null)[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

async function rowOf(org: OrgContext, sha: Sha256) {
  return (
    await rows<{
      purge_generation: string | null;
      purge_lease_until: string | null;
      purge_after: string | null;
      deleted_at: string | null;
      refetchable: number;
      size_bytes: number;
    }>(
      'SELECT purge_generation, purge_lease_until, purge_after, deleted_at, refetchable, size_bytes FROM blob WHERE org_id = ? AND sha256 = ?',
      org.orgId,
      sha,
    )
  )[0];
}

async function count(): Promise<number> {
  return (await rows<{ n: number }>('SELECT count(*) AS n FROM blob'))[0]?.n ?? -1;
}

const input = (over: Record<string, unknown> = {}) => ({
  sha256: D1,
  size: 10,
  mediaType: 'application/zip',
  refetchable: true,
  ...over,
});

async function publish(
  repo = createBlobRepository(executor),
  org = a,
  over: Record<string, unknown> = {},
) {
  const generation = await repo.reserve(org, (over.sha256 as Sha256 | undefined) ?? D1);
  const info = await repo.publish(org, { ...input(over), generation });
  return { info, generation };
}

async function expireLease(org: OrgContext, sha: Sha256): Promise<void> {
  await exec(
    "UPDATE blob SET purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds') WHERE org_id = ? AND sha256 = ?",
    org.orgId,
    sha,
  );
}

async function makeEligible(org: OrgContext, sha: Sha256): Promise<void> {
  await exec(
    "UPDATE blob SET published_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND sha256 = ?",
    org.orgId,
    sha,
  );
}

async function reference(type = 'npmjs_proxy', status = 'active'): Promise<void> {
  await exec(
    "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'npm', ?)",
    a.orgId,
    type,
  );
  await exec(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('P', ?, 'S', 'npm', 'p')",
    a.orgId,
  );
  await exec(
    "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at) SELECT 'V', org_id, 'P', '1.0.0', '1.0.0', created_at, 'upstream', '{}', id, ?, ? FROM blob WHERE org_id = ? AND sha256 = ?",
    status,
    status === 'tombstoned' ? '2000-01-01T00:00:00.000Z' : null,
    a.orgId,
    D1,
  );
}

async function due(org: OrgContext, sha: Sha256): Promise<void> {
  await makeEligible(org, sha);
  await exec(
    "UPDATE blob SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days') WHERE org_id = ? AND sha256 = ?",
    org.orgId,
    sha,
  );
}

describe('schema assertions (0006 shape)', () => {
  it('has both purge columns as nullable TEXT and a unique digest index', async () => {
    const info = await rows<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
      'SELECT name, type, "notnull", dflt_value FROM pragma_table_info(\'blob\')',
    );
    for (const name of ['purge_generation', 'purge_lease_until']) {
      const column = info.find((c) => c.name === name);
      expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    }
    const index = await rows<{ unique: number }>(
      "SELECT \"unique\" FROM pragma_index_list('blob') WHERE name = 'blob_digest'",
    );
    expect(index[0]?.unique).toBe(1);
    const cols = await rows<{ name: string }>(
      "SELECT name FROM pragma_index_info('blob_digest') ORDER BY seqno",
    );
    expect(cols.map((c) => c.name)).toEqual(['org_id', 'sha256']);
  });
});

describe('BlobTable columns', () => {
  it('matches pragma_table_info exactly', async () => {
    const info = await rows<{ name: string; type: string; notnull: number }>(
      'SELECT name, type, "notnull" FROM pragma_table_info(\'blob\') ORDER BY cid',
    );
    expect(info.map((c) => [c.name, c.type, c.notnull])).toEqual([
      ['id', 'TEXT', 1],
      ['org_id', 'TEXT', 1],
      ['sha256', 'TEXT', 1],
      ['size_bytes', 'INTEGER', 1],
      ['storage_key', 'TEXT', 1],
      ['media_type', 'TEXT', 1],
      ['refetchable', 'INTEGER', 1],
      ['upstream_url', 'TEXT', 0],
      ['last_fetched_at', 'TEXT', 0],
      ['last_accessed_at', 'TEXT', 0],
      ['purge_after', 'TEXT', 0],
      ['deleted_at', 'TEXT', 0],
      ['created_at', 'TEXT', 1],
      ['purge_generation', 'TEXT', 0],
      ['purge_lease_until', 'TEXT', 0],
      ['published_at', 'TEXT', 0],
    ]);
  });
});

describe('reserve', () => {
  it('on an absent digest stores nothing and find stays null', async () => {
    const repo = createBlobRepository(executor);
    const generation = await repo.reserve(a, D1);
    expect(generation).toMatch(GEN);
    expect(await count()).toBe(0);
    expect(await repo.find(a, D1)).toBeNull();
  });

  it('on an existing row returns a different token each time', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    const first = await repo.reserve(a, D1);
    const second = await repo.reserve(a, D1);
    expect(first).not.toBe(second);
    expect((await rowOf(a, D1))?.purge_generation).toBe(second);
  });

  it('bumps the generation of a deleted row without a live lease', async () => {
    const repo = createBlobRepository(executor);
    const { generation } = await publish(repo);
    await exec(
      'UPDATE blob SET deleted_at = ? WHERE org_id = ?',
      '2020-01-01T00:00:00.000Z',
      a.orgId,
    );
    const next = await repo.reserve(a, D1);
    expect(next).not.toBe(generation);
  });

  it('throws BlobBusyError during a live lease and leaves the generation unchanged', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    const claimed = await repo.claimPurge(a, D1);
    expect(claimed).not.toBeNull();
    await expect(repo.reserve(a, D1)).rejects.toBeInstanceOf(BlobBusyError);
    expect((await rowOf(a, D1))?.purge_generation).toBe(claimed);
  });

  it('rejects an invalid digest', async () => {
    await expect(
      createBlobRepository(executor).reserve(a, 'nope' as Sha256),
    ).rejects.toBeInstanceOf(BlobValidationError);
  });
});

describe('publish', () => {
  it('preserves legacy reads without inventing a reusable generation', async () => {
    const repo = createBlobRepository(executor);
    await exec(
      'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type) VALUES (?, ?, ?, 10, ?, ?)',
      'legacy',
      a.orgId,
      D1,
      'legacy',
      'application/zip',
    );
    expect((await repo.find(a, D1))?.generation).toBe('');
    const { info, generation } = await publish(repo);
    expect(generation).toMatch(GEN);
    expect(info?.generation).toBe(generation);
    expect((await repo.inspect(a, D1))?.info.generation).toBe(generation);
  });

  it('inserts the row and reads it back through find and inspect', async () => {
    const repo = createBlobRepository(executor);
    const { info, generation } = await publish(repo);
    expect(info).toEqual({
      generation,
      sha256: D1,
      size: 10,
      mediaType: 'application/zip',
      purgeAfter: null,
    });
    expect(await repo.find(a, D1)).toEqual(info);
    expect(await repo.inspect(a, D1)).toEqual({ info, purging: false });
    const stored = await rows<{ storage_key: string }>('SELECT storage_key FROM blob');
    expect(stored[0]?.storage_key).toMatch(/^sha256\/[0-9a-f]+\/aa\/a+$/);
  });

  it.each([false, true])(
    'refreshes publication time on re-publish (deleted: %s)',
    async (deleted) => {
      const repo = createBlobRepository(executor);
      await publish(repo);
      await exec(
        "UPDATE blob SET created_at = '2000-01-01T00:00:00.000Z', published_at = '2000-01-01T00:00:00.000Z', deleted_at = ?",
        deleted ? '2000-01-02T00:00:00.000Z' : null,
      );
      expect((await publish(repo)).info).not.toBeNull();
      const stored = await rows<{ created_at: string; recent: number; deleted_at: string | null }>(
        "SELECT created_at, julianday(published_at) >= julianday('now', '-1 minute') AS recent, deleted_at FROM blob",
      );
      expect(stored).toEqual([
        { created_at: '2000-01-01T00:00:00.000Z', recent: 1, deleted_at: null },
      ]);
    },
  );

  it('sets publication time on the first publish', async () => {
    await publish();
    const stored = await rows<{ recent: number }>(
      "SELECT julianday(published_at) >= julianday('now', '-1 minute') AS recent FROM blob",
    );
    expect(stored).toEqual([{ recent: 1 }]);
  });

  it('is idempotent for the same digest and size', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    const again = await publish(repo);
    expect(again.info).not.toBeNull();
    expect(await count()).toBe(1);
  });

  it('returns null and changes nothing for a stale generation', async () => {
    const repo = createBlobRepository(executor);
    const { generation } = await publish(repo);
    await repo.reserve(a, D1);
    const before = await rowOf(a, D1);
    expect(await repo.publish(a, { ...input({ refetchable: false }), generation })).toBeNull();
    expect(await rowOf(a, D1)).toEqual(before);
  });

  it('inserts a first publish on an unpublished digest', async () => {
    const repo = createBlobRepository(executor);
    const generation = await repo.reserve(a, D2);
    expect(await repo.publish(a, { ...input({ sha256: D2 }), generation })).not.toBeNull();
  });

  it('refuses a size conflict', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    const generation = await repo.reserve(a, D1);
    await expect(repo.publish(a, { ...input({ size: 11 }), generation })).rejects.toBeInstanceOf(
      BlobConflictError,
    );
  });

  it('refuses a media type conflict, even with a stale generation', async () => {
    const repo = createBlobRepository(executor);
    const { generation } = await publish(repo);
    await repo.reserve(a, D1);
    await expect(
      repo.publish(a, { ...input({ mediaType: 'application/json' }), generation }),
    ).rejects.toBeInstanceOf(BlobConflictError);
  });

  it('a deleted row is exempt from the media type conflict; live rows are not', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await exec("UPDATE blob SET deleted_at = '2020-01-01T00:00:00.000Z'");
    const generation = await repo.reserve(a, D1);
    const info = await repo.publish(a, { ...input({ mediaType: 'application/json' }), generation });
    expect(info?.mediaType).toBe('application/json');
    const again = await repo.reserve(a, D1);
    await expect(
      repo.publish(a, { ...input({ mediaType: 'application/zip' }), generation: again }),
    ).rejects.toBeInstanceOf(BlobConflictError);
  });

  it('rewrites storage_key to the canonical key on update', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    const canonical = (await rows<{ storage_key: string }>('SELECT storage_key FROM blob'))[0]
      ?.storage_key;
    await exec("UPDATE blob SET storage_key = 'tampered'");
    await publish(repo);
    expect(
      (await rows<{ storage_key: string }>('SELECT storage_key FROM blob'))[0]?.storage_key,
    ).toBe(canonical);
  });

  it('two first publishes with different tokens: the second is null, then succeeds after a re-reserve', async () => {
    const repo = createBlobRepository(executor);
    const first = await repo.reserve(a, D1);
    const second = await repo.reserve(a, D1);
    expect(first).not.toBe(second);
    expect(await repo.publish(a, { ...input(), generation: first })).not.toBeNull();
    expect(await repo.publish(a, { ...input(), generation: second })).toBeNull();
    const again = await repo.reserve(a, D1);
    expect(await repo.publish(a, { ...input(), generation: again })).not.toBeNull();
    expect(await count()).toBe(1);
  });

  it('a reserve token from one organization fails publish in another', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, b);
    const token = await repo.reserve(a, D1);
    expect(await repo.publish(b, { ...input(), generation: token })).toBeNull();
    expect(await rowOf(a, D1)).toBeUndefined();
  });

  it('republishing a deleted row takes refetchable and fetch metadata from the new publish', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, a, { refetchable: false });
    await exec(
      "UPDATE blob SET deleted_at = '2020-01-01T00:00:00.000Z', upstream_url = 'https://old.example/x', last_fetched_at = '2020-01-01T00:00:00.000Z', last_accessed_at = '2020-01-02T00:00:00.000Z'",
    );
    await publish(repo, a, { refetchable: true });
    const [r] = await rows<{
      refetchable: number;
      upstream_url: string | null;
      last_fetched_at: string | null;
      last_accessed_at: string | null;
    }>('SELECT refetchable, upstream_url, last_fetched_at, last_accessed_at FROM blob');
    expect(r).toEqual({
      refetchable: 1,
      upstream_url: null,
      last_fetched_at: null,
      last_accessed_at: null,
    });
  });

  it('a live row keeps its fetch metadata and ANDed refetchable on republish', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await exec(
      "UPDATE blob SET upstream_url = 'https://u.example/x', last_fetched_at = '2020-01-01T00:00:00.000Z'",
    );
    await publish(repo, a, { refetchable: false });
    const [r] = await rows<{ refetchable: number; upstream_url: string | null }>(
      'SELECT refetchable, upstream_url FROM blob',
    );
    expect(r).toEqual({ refetchable: 0, upstream_url: 'https://u.example/x' });
  });

  it('republishing a deleted row with a different size succeeds', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await exec("UPDATE blob SET deleted_at = '2020-01-01T00:00:00.000Z'");
    const { info } = await publish(repo, a, { size: 99 });
    expect(info?.size).toBe(99);
    expect((await rowOf(a, D1))?.size_bytes).toBe(99);
  });

  it('ANDs refetchable', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, a, { refetchable: true });
    await publish(repo, a, { refetchable: false });
    expect((await rowOf(a, D1))?.refetchable).toBe(0);
    await publish(repo, a, { refetchable: true });
    expect((await rowOf(a, D1))?.refetchable).toBe(0);
  });

  it('clears purge_after and deleted_at over a soft-deleted or deleted row', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    expect((await rowOf(a, D1))?.purge_after).not.toBeNull();
    await publish(repo);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    await exec(
      "UPDATE blob SET deleted_at = '2020-01-01T00:00:00.000Z', purge_after = '2020-02-01T00:00:00.000Z'",
    );
    const { info } = await publish(repo);
    expect(info?.purgeAfter).toBeNull();
    const row = await rowOf(a, D1);
    expect(row?.deleted_at).toBeNull();
    expect(row?.purge_after).toBeNull();
  });

  it('returns null while a purge lease is live', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    const claimed = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(await repo.publish(a, { ...input(), generation: claimed })).toBeNull();
  });

  it('validates input before I/O', async () => {
    const counted = countCalls(executor);
    const repo = createBlobRepository(counted.executor);
    const generation = 'f'.repeat(32) as PurgeGeneration;
    const bad: Record<string, unknown>[] = [
      { sha256: 'x' },
      { size: -1 },
      { size: 1.5 },
      { mediaType: 'text/html' },
      { refetchable: 1 },
    ];
    for (const over of bad) {
      await expect(repo.publish(a, { ...input(over), generation } as never)).rejects.toBeInstanceOf(
        BlobValidationError,
      );
    }
    await expect(
      repo.publish(a, { ...input(), generation: 'ZZ' as PurgeGeneration }),
    ).rejects.toBeInstanceOf(BlobValidationError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('find and inspect', () => {
  it('hide never-published rows', async () => {
    const repo = createBlobRepository(executor);
    expect(await repo.find(a, D1)).toBeNull();
    expect(await repo.inspect(a, D1)).toBeNull();
  });

  it('find hides deleted rows and rows under a live lease; inspect reports purging', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    expect(await repo.claimPurge(a, D1)).not.toBeNull();
    expect(await repo.find(a, D1)).toBeNull();
    expect((await repo.inspect(a, D1))?.purging).toBe(true);
    await exec("UPDATE blob SET deleted_at = '2020-01-01T00:00:00.000Z'");
    expect(await repo.find(a, D1)).toBeNull();
    expect(await repo.inspect(a, D1)).toBeNull();
  });

  it('serve a row again after the lease expires', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    await repo.claimPurge(a, D1);
    await expireLease(a, D1);
    expect(await repo.find(a, D1)).not.toBeNull();
    expect((await repo.inspect(a, D1))?.purging).toBe(false);
  });
});

describe('narrowRefetchable', () => {
  const args = { key: D1, size: 10, mediaType: 'application/zip' };

  it('clears refetchable without touching the generation', async () => {
    const repo = createBlobRepository(executor);
    const { generation } = await publish(repo);
    const narrowed = await repo.narrowRefetchable(a, args);
    expect(narrowed).toEqual({
      generation,
      sha256: D1,
      size: 10,
      mediaType: 'application/zip',
      purgeAfter: null,
    });
    const row = await rowOf(a, D1);
    expect(row?.refetchable).toBe(0);
    expect(row?.purge_generation).toBe(generation);
    expect(await repo.narrowRefetchable(a, args)).not.toBeNull();
  });

  it('returns null for an absent row, a different size or media type, or another organization', async () => {
    const repo = createBlobRepository(executor);
    expect(await repo.narrowRefetchable(a, args)).toBeNull();
    await publish(repo);
    expect(await repo.narrowRefetchable(a, { ...args, size: 11 })).toBeNull();
    expect(await repo.narrowRefetchable(a, { ...args, mediaType: 'text/plain' })).toBeNull();
    expect(await repo.narrowRefetchable(b, args)).toBeNull();
    expect((await rowOf(a, D1))?.refetchable).toBe(1);
  });

  it('refuses under a scheduled purge and under a live lease, leaving the row untouched', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    const scheduled = await rowOf(a, D1);
    expect(await repo.narrowRefetchable(a, args)).toBeNull();
    await due(a, D1);
    const claimed = await repo.claimPurge(a, D1);
    expect(claimed).not.toBeNull();
    expect(await repo.narrowRefetchable(a, args)).toBeNull();
    const row = await rowOf(a, D1);
    expect(row?.refetchable).toBe(1);
    expect(row?.purge_generation).toBe(claimed);
    expect(scheduled?.refetchable).toBe(1);
  });

  it('refuses on a deleted row', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await exec(
      'UPDATE blob SET deleted_at = ? WHERE org_id = ?',
      '2020-01-01T00:00:00.000Z',
      a.orgId,
    );
    expect(await repo.narrowRefetchable(a, args)).toBeNull();
  });

  it('rejects invalid input', async () => {
    const repo = createBlobRepository(executor);
    await expect(repo.narrowRefetchable(a, { ...args, size: -1 })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
    await expect(repo.narrowRefetchable(a, { ...args, mediaType: 'x/y' })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
  });
});

describe('softDelete', () => {
  it('anchors the deadline at database time plus the organization retention', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await exec(
      'UPDATE organization SET retention_removed_upstream_days = 30 WHERE id = ?',
      a.orgId,
    );
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    const [r] = await rows<{ days: number }>(
      'SELECT julianday(purge_after) - julianday(?) AS days FROM blob',
      new Date().toISOString(),
    );
    expect(r?.days).toBeGreaterThan(29.9);
    expect(r?.days).toBeLessThan(30.1);
  });

  it('a 2020 removedAt does not make the row claimable before now plus retention', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect(await repo.claimPurge(a, D1)).toBeNull();
  });

  it('keeps the first-observation deadline across repeats, retention changes and clock advance', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    expect(await repo.softDelete(a, D1, { removedAt: '2020-02-01T00:00:00.000Z' })).toBe(true);
    await exec("UPDATE blob SET purge_after = '2021-01-01T00:00:00.000Z'");
    const before = await rowOf(a, D1);
    for (const days of [30, 90]) {
      await exec(
        'UPDATE organization SET retention_removed_upstream_days = ? WHERE id = ?',
        days,
        a.orgId,
      );
      expect(await repo.softDelete(a, D1, { removedAt: '2020-02-01T00:00:00.000Z' })).toBe(true);
      const after = await rowOf(a, D1);
      expect(after?.purge_after).toBe('2021-01-01T00:00:00.000Z');
      expect(after?.purge_generation).toBe(before?.purge_generation);
    }
  });

  it('uses the caller organization retention', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, a);
    await publish(repo, b);
    await exec(
      'UPDATE organization SET retention_removed_upstream_days = 10 WHERE id = ?',
      a.orgId,
    );
    await exec(
      'UPDATE organization SET retention_removed_upstream_days = 100 WHERE id = ?',
      b.orgId,
    );
    expect(await repo.softDelete(b, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    const [r] = await rows<{ days: number }>(
      'SELECT julianday(purge_after) - julianday(?) AS days FROM blob WHERE org_id = ?',
      new Date().toISOString(),
      b.orgId,
    );
    expect(r?.days).toBeGreaterThan(99.9);
  });

  it('refuses a malformed removedAt without I/O', async () => {
    const counted = countCalls(executor);
    const repo = createBlobRepository(counted.executor);
    for (const removedAt of [
      'yesterday',
      '2020-01-01',
      '2020-01-01T00:00:00Z',
      '2020-13-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000+01:00',
    ]) {
      await expect(repo.softDelete(a, D1, { removedAt })).rejects.toBeInstanceOf(
        BlobValidationError,
      );
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('returns false for a future removedAt, an absent row and a deleted row', async () => {
    const repo = createBlobRepository(executor);
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(false);
    await publish(repo);
    expect(await repo.softDelete(a, D1, { removedAt: '2999-01-01T00:00:00.000Z' })).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    await exec("UPDATE blob SET deleted_at = '2020-01-01T00:00:00.000Z'");
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('during a live lease then cancelPurge by the claim token', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo);
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    await due(a, D1);
    const claimed = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect(await repo.cancelPurge(a, D1, claimed)).toBe(true);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
  });
});

describe('purge lifecycle', () => {
  async function scheduled() {
    const repo = createBlobRepository(executor);
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    return repo;
  }

  it.each(['active', 'hosted', 'young', 'reput'])(
    'refuses a claim for %s blobs without hiding them',
    async (state) => {
      const repo = await scheduled();
      if (state === 'active') await reference();
      if (state === 'hosted') await reference('hosted', 'tombstoned');
      if (state === 'young')
        await exec("UPDATE blob SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      if (state === 'reput') {
        await publish(repo);
        await exec("UPDATE blob SET purge_after = '2000-01-01T00:00:00.000Z'");
      }
      expect(await repo.claimPurge(a, D1)).toBeNull();
      expect((await rowOf(a, D1))?.purge_lease_until).toBeNull();
      expect(await repo.find(a, D1)).not.toBeNull();
    },
  );

  it.each(['markDeleted', 'cancelPurge'] as const)(
    'rechecks a new reference but still permits %s',
    async (finish) => {
      const repo = await scheduled();
      const generation = (await repo.claimPurge(a, D1)) as PurgeGeneration;
      expect(await repo.canStartRemove(a, D1, generation, 1000)).toBe(true);
      await reference();
      expect(await repo.canStartRemove(a, D1, generation, 1000)).toBe(false);
      expect(await repo[finish](a, D1, 'f'.repeat(32) as PurgeGeneration)).toBe(false);
      expect(await repo[finish](a, D1, generation)).toBe(true);
      expect((await rowOf(a, D1))?.purge_lease_until).toBeNull();
      if (finish === 'cancelPurge') expect((await rowOf(a, D1))?.purge_after).toBeNull();
    },
  );

  it.each(['referenced', 'young', 'eligible', 'leased', 'unscheduled', 'deleted'])(
    'unschedules only unleased ineligible rows: %s',
    async (state) => {
      const repo = await scheduled();
      if (state === 'leased') expect(await repo.claimPurge(a, D1)).toMatch(GEN);
      if (state !== 'eligible') await reference();
      if (state === 'young') {
        await exec('DELETE FROM version WHERE org_id = ?', a.orgId);
        await exec("UPDATE blob SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      }
      if (state === 'unscheduled') await exec('UPDATE blob SET purge_after = NULL');
      if (state === 'deleted')
        await exec("UPDATE blob SET deleted_at = '2000-01-01T00:00:00.000Z'");
      const before = await rowOf(a, D1);
      const clears = state === 'referenced' || state === 'young';
      expect(await repo.unschedule(a, D1)).toBe(clears);
      expect(await rowOf(a, D1)).toEqual(clears ? { ...before, purge_after: null } : before);
    },
  );

  it.each(['claimPurge', 'canStartRemove', 'unschedule'] as const)(
    '%s treats another organization as absent',
    async (method) => {
      const repo = await scheduled();
      const generation =
        method === 'canStartRemove'
          ? ((await repo.claimPurge(a, D1)) as PurgeGeneration)
          : ('f'.repeat(32) as PurgeGeneration);
      if (method === 'unschedule') await reference();
      const before = await rowOf(a, D1);
      expect(await repo[method](b, D1, generation, 1000)).toBe(
        await repo[method](b, D2, generation, 1000),
      );
      expect(await repo.find(b, D1)).toBeNull();
      expect(await rowOf(a, D1)).toEqual(before);
    },
  );

  it('claimPurge needs a due purge_after', async () => {
    const repo = createBlobRepository(executor);
    expect(await repo.claimPurge(a, D1)).toBeNull();
    await publish(repo);
    await makeEligible(a, D1);
    expect(await repo.claimPurge(a, D1)).toBeNull();
    await repo.softDelete(a, D1, { removedAt: new Date().toISOString() });
    expect(await repo.claimPurge(a, D1)).toBeNull();
    await due(a, D1);
    expect(await repo.claimPurge(a, D1)).toMatch(GEN);
  });

  it('is exclusive while live and fences the old holder after expiry', async () => {
    const repo = await scheduled();
    const first = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(first).toMatch(GEN);
    expect(await repo.claimPurge(a, D1)).toBeNull();
    await expireLease(a, D1);
    const second = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(second).not.toBe(first);
    expect(await repo.markDeleted(a, D1, first)).toBe(false);
    expect(await repo.cancelPurge(a, D1, first)).toBe(false);
    expect(await repo.canStartRemove(a, D1, first, 1000)).toBe(false);
    expect(await repo.canStartRemove(a, D1, second, 1000)).toBe(true);
  });

  it('a claim invalidates an earlier reservation', async () => {
    const repo = await scheduled();
    const reserved = await repo.reserve(a, D1);
    await repo.claimPurge(a, D1);
    await expireLease(a, D1);
    expect(await repo.publish(a, { ...input(), generation: reserved })).toBeNull();
  });

  it('canStartRemove is false when the remaining lease is shorter than the timeout', async () => {
    const repo = await scheduled();
    const generation = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(await repo.canStartRemove(a, D1, generation, 5000)).toBe(true);
    await exec(
      "UPDATE blob SET purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 seconds')",
    );
    expect(await repo.canStartRemove(a, D1, generation, 5000)).toBe(false);
    expect(await repo.canStartRemove(a, D1, generation, 1000)).toBe(true);
  });

  it('markDeleted sets deleted_at, clears the lease and is a generation CAS', async () => {
    const repo = await scheduled();
    const generation = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(await repo.markDeleted(a, D1, 'f'.repeat(32) as PurgeGeneration)).toBe(false);
    expect(await repo.markDeleted(a, D1, generation)).toBe(true);
    const row = await rowOf(a, D1);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.purge_lease_until).toBeNull();
    expect(await repo.markDeleted(a, D1, generation)).toBe(false);
  });

  it('cancelPurge clears the schedule and lease but keeps the generation', async () => {
    const repo = await scheduled();
    const reserved = await repo.reserve(a, D1);
    const generation = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    expect(await repo.cancelPurge(a, D1, generation)).toBe(true);
    const row = await rowOf(a, D1);
    expect(row?.purge_after).toBeNull();
    expect(row?.purge_lease_until).toBeNull();
    expect(row?.purge_generation).toBe(generation);
    expect(await repo.publish(a, { ...input(), generation: reserved })).toBeNull();
  });

  it('a reserve or publish token cannot markDeleted or cancelPurge', async () => {
    const repo = createBlobRepository(executor);
    const { generation } = await publish(repo);
    expect(await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    await due(a, D1);
    expect(await repo.markDeleted(a, D1, generation)).toBe(false);
    expect(await repo.cancelPurge(a, D1, generation)).toBe(false);
    const reserved = await repo.reserve(a, D1);
    expect(await repo.markDeleted(a, D1, reserved)).toBe(false);
    expect(await repo.cancelPurge(a, D1, reserved)).toBe(false);
    const row = await rowOf(a, D1);
    expect(row?.deleted_at).toBeNull();
    expect(row?.purge_after).not.toBeNull();
  });

  it('re-reserve and republish of a deleted row while an expired holder calls canStartRemove', async () => {
    const repo = await scheduled();
    const holder = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    await expireLease(a, D1);
    expect(await repo.markDeleted(a, D1, holder)).toBe(true);
    const generation = await repo.reserve(a, D1);
    expect(await repo.canStartRemove(a, D1, holder, 1000)).toBe(false);
    expect(await repo.publish(a, { ...input(), generation })).not.toBeNull();
    expect(await repo.canStartRemove(a, D1, holder, 1000)).toBe(false);
    expect(await repo.find(a, D1)).not.toBeNull();
  });

  it('a stale expired lease cannot let a reserve token markDeleted or cancelPurge', async () => {
    const repo = await scheduled();
    await repo.claimPurge(a, D1);
    await expireLease(a, D1);
    const reserved = await repo.reserve(a, D1);
    expect((await rowOf(a, D1))?.purge_lease_until).toBeNull();
    expect(await repo.markDeleted(a, D1, reserved)).toBe(false);
    expect(await repo.cancelPurge(a, D1, reserved)).toBe(false);
    const row = await rowOf(a, D1);
    expect(row?.deleted_at).toBeNull();
    expect(row?.purge_after).not.toBeNull();
    expect(await repo.find(a, D1)).not.toBeNull();
  });

  it('a publish clears an expired lease', async () => {
    const repo = await scheduled();
    await repo.claimPurge(a, D1);
    await expireLease(a, D1);
    const generation = await repo.reserve(a, D1);
    await exec("UPDATE blob SET purge_lease_until = '2000-01-01T00:00:00.000Z'");
    expect(await repo.publish(a, { ...input(), generation })).not.toBeNull();
    expect((await rowOf(a, D1))?.purge_lease_until).toBeNull();
  });

  it('validates generations and timeouts before I/O', async () => {
    const counted = countCalls(executor);
    const repo = createBlobRepository(counted.executor);
    await expect(repo.markDeleted(a, D1, 'x' as PurgeGeneration)).rejects.toBeInstanceOf(
      BlobValidationError,
    );
    await expect(repo.cancelPurge(a, D1, 'x' as PurgeGeneration)).rejects.toBeInstanceOf(
      BlobValidationError,
    );
    await expect(
      repo.canStartRemove(a, D1, 'f'.repeat(32) as PurgeGeneration, -1),
    ).rejects.toBeInstanceOf(BlobValidationError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('rejects an invalid purgeLeaseSeconds at construction', () => {
    expect(() => createBlobRepository(executor, { purgeLeaseSeconds: 59 })).toThrow(
      BlobValidationError,
    );
    expect(() => createBlobRepository(executor, { purgeLeaseSeconds: 60.5 })).toThrow(
      BlobValidationError,
    );
    expect(() => createBlobRepository(executor, { purgeLeaseSeconds: 60 })).not.toThrow();
  });

  it('honours purgeLeaseSeconds', async () => {
    const repo = createBlobRepository(executor, { purgeLeaseSeconds: 120 });
    await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    await repo.claimPurge(a, D1);
    const [r] = await rows<{ s: number }>(
      "SELECT (julianday(purge_lease_until) - julianday('now')) * 86400 AS s FROM blob",
    );
    expect(r?.s).toBeGreaterThan(100);
    expect(r?.s).toBeLessThanOrEqual(121);
  });
});

describe('isolation and effects', () => {
  it('a live lease in B leaves reserve in A working', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, a);
    await publish(repo, b);
    expect(await repo.softDelete(b, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    await due(b, D1);
    expect(await repo.claimPurge(b, D1)).not.toBeNull();
    expect(await repo.reserve(a, D1)).toMatch(GEN);
    await expect(repo.reserve(b, D1)).rejects.toBeInstanceOf(BlobBusyError);
  });

  it('two organizations never see or collide across digests', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, a);
    expect(await repo.find(b, D1)).toBeNull();
    expect(await repo.inspect(b, D1)).toBeNull();
    const gen = await repo.reserve(b, D1);
    expect(await repo.publish(b, { ...input({ size: 99 }), generation: gen })).not.toBeNull();
    expect((await repo.find(a, D1))?.size).toBe(10);
    expect((await repo.find(b, D1))?.size).toBe(99);
    expect(await repo.softDelete(b, D1, { removedAt: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    await due(b, D1);
    expect(await repo.claimPurge(a, D1)).toBeNull();
    const claimed = (await repo.claimPurge(b, D1)) as PurgeGeneration;
    expect(await repo.markDeleted(a, D1, claimed)).toBe(false);
    expect(await repo.cancelPurge(a, D1, claimed)).toBe(false);
    expect(await repo.canStartRemove(a, D1, claimed, 1000)).toBe(false);
    expect(await repo.find(a, D1)).not.toBeNull();
  });

  it('makes one executor call per method', async () => {
    const counted = countCalls(executor);
    const repo = createBlobRepository(counted.executor);
    const total = () => counted.counts().all + counted.counts().batch;
    const calls = async (fn: () => Promise<unknown>): Promise<number> => {
      const before = total();
      await fn();
      return total() - before;
    };
    let generation = '' as PurgeGeneration;
    expect(
      await calls(async () => {
        generation = await repo.reserve(a, D1);
      }),
    ).toBe(1);
    expect(await calls(() => repo.publish(a, { ...input(), generation }))).toBe(1);
    expect(await calls(() => repo.find(a, D1))).toBe(1);
    expect(await calls(() => repo.inspect(a, D1))).toBe(1);
    expect(
      await calls(() => repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' })),
    ).toBe(1);
    await due(a, D1);
    let claimed = '' as PurgeGeneration;
    expect(
      await calls(async () => {
        claimed = (await repo.claimPurge(a, D1)) as PurgeGeneration;
      }),
    ).toBe(1);
    expect(await calls(() => repo.canStartRemove(a, D1, claimed, 1000))).toBe(1);
    expect(await calls(() => repo.markDeleted(a, D1, claimed))).toBe(1);
    expect(await calls(() => repo.cancelPurge(a, D1, claimed))).toBe(1);
  });

  it('never touches cache_epoch', async () => {
    const repo = createBlobRepository(executor);
    const read = async () =>
      rows<{ org_id: string; version: string }>(
        'SELECT org_id, version FROM cache_epoch ORDER BY org_id',
      );
    const guard = () => rows<{ key: string }>('SELECT key FROM access_mutation_guard ORDER BY key');
    const before = await read();
    const guardBefore = await guard();
    expect(before).toHaveLength(2);
    const { generation } = await publish(repo);
    await repo.softDelete(a, D1, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D1);
    const claimed = (await repo.claimPurge(a, D1)) as PurgeGeneration;
    await repo.markDeleted(a, D1, claimed);
    await publish(repo, a, { sha256: D2 });
    await repo.softDelete(a, D2, { removedAt: '2020-01-01T00:00:00.000Z' });
    await due(a, D2);
    const second = (await repo.claimPurge(a, D2)) as PurgeGeneration;
    await repo.cancelPurge(a, D2, second);
    expect(generation).toMatch(TOKEN);
    expect(await read()).toEqual(before);
    expect(await guard()).toEqual(guardBefore);
  });
});

describe('blob writer shared purge lease boundary', () => {
  it.each([
    ['one tick before', '2026-10-17T11:59:59.999Z', true],
    ['equal to now', '2026-10-17T12:00:00.000Z', true],
    ['one tick after', '2026-10-17T12:00:00.001Z', false],
  ] as const)('publish handles a lease %s', async (_label, lease, available) => {
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
      const repo = createBlobRepository(executor);
      const { generation } = await publish(repo);
      await exec(
        'UPDATE blob SET purge_lease_until = ? WHERE org_id = ? AND sha256 = ?',
        lease,
        a.orgId,
        D1,
      );
      shared.mockClear();
      const result = await repo.publish(a, { ...input(), generation });
      expect(result !== null).toBe(available);
      expect(shared).toHaveBeenCalledWith('blob.purge_lease_until');
      expect((await rowOf(a, D1))?.purge_lease_until).toBe(available ? null : lease);
    } finally {
      shared.mockRestore();
    }
  });
});

describe('scheduleOrphan', () => {
  const DAYS_AGO = (days: number) =>
    `UPDATE blob SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days')`;

  async function orphan(days: number, org = a, sha = D1) {
    const repo = createBlobRepository(executor);
    await publish(repo, org, { sha256: sha });
    await exec(`${DAYS_AGO(days)} WHERE org_id = ? AND sha256 = ?`, org.orgId, sha);
    return repo;
  }

  async function ingestSnapshot(): Promise<void> {
    await exec(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'npm', 'npmjs_proxy')",
      a.orgId,
    );
    await exec(
      `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)
        VALUES ('ING1', ?, 'source', ?, 'S', 1, 'o', 1, '2099-01-01T00:00:00.000Z', 'running', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      a.orgId,
      'c'.repeat(64),
      D1,
    );
  }

  async function upstreamHash(): Promise<void> {
    await reference('npmjs_proxy', 'tombstoned');
    await exec('DELETE FROM version WHERE org_id = ?', a.orgId);
    await exec(
      `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)
        VALUES (?, 'P', 'composer-p2', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      a.orgId,
      D1,
    );
  }

  it('schedules a refetchable orphan past grace at database now, and the claim then succeeds', async () => {
    const repo = await orphan(8);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    const [clock] = await rows<{ now: string }>(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now",
    );
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
    const purgeAfter = (await rowOf(a, D1))?.purge_after as string;
    expect(purgeAfter >= (clock?.now as string)).toBe(true);
    expect(await repo.claimPurge(a, D1)).toMatch(GEN);
  });

  it('leaves an orphan inside the grace period unscheduled', async () => {
    const repo = await orphan(6);
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    expect(await repo.claimPurge(a, D1)).toBeNull();
  });

  it.each([
    ['an active version', () => reference('npmjs_proxy', 'active')],
    ['a hosted-source reference', () => reference('hosted', 'tombstoned')],
    ['an ingest snapshot', () => ingestSnapshot()],
    ['an upstream_state hash', () => upstreamHash()],
  ])('refuses a blob held by %s', async (_label, hold) => {
    const repo = await orphan(8);
    await hold();
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
  });

  it('refuses a blob that only a revision references', async () => {
    const repo = await orphan(8);
    await reference('npmjs_proxy', 'tombstoned');
    await exec(
      "INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) SELECT 'VR', org_id, 'V', 1, id, '{}', 'test' FROM blob WHERE org_id = ?",
      a.orgId,
    );
    await exec('UPDATE version SET blob_id = NULL WHERE org_id = ?', a.orgId);
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
  });

  it('never schedules a non-refetchable blob, and does once it is refetchable', async () => {
    const repo = createBlobRepository(executor);
    await publish(repo, a, { refetchable: false });
    await exec(`${DAYS_AGO(400)} WHERE org_id = ?`, a.orgId);
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    await exec('UPDATE blob SET refetchable = 1 WHERE org_id = ?', a.orgId);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
  });

  it('a re-put after scheduling refreshes the age so the claim returns null', async () => {
    const repo = await orphan(8);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
    await publish(repo);
    await exec("UPDATE blob SET purge_after = '2000-01-01T00:00:00.000Z'");
    expect(await repo.claimPurge(a, D1)).toBeNull();
    expect((await rowOf(a, D1))?.purge_lease_until).toBeNull();
  });

  it('a new reference after scheduling cancels the purge at claim time', async () => {
    const repo = await orphan(8);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
    await reference('npmjs_proxy', 'active');
    expect(await repo.claimPurge(a, D1)).toBeNull();
  });

  it.each([
    ['a live', '2999-01-01T00:00:00.000Z', false],
    ['an expired', '2000-01-01T00:00:00.000Z', true],
  ])('with %s import before-image schedules: %s', async (_label, expiresAt, schedules) => {
    const repo = await orphan(8);
    await exec(
      "INSERT INTO import_run (id, org_id, source_system, before_image_expires_at) VALUES ('RUN1', ?, 'x', ?)",
      a.orgId,
      expiresAt,
    );
    await exec(
      `INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json)
        SELECT 'REF1', org_id, 'RUN1', 'version', 'VERX', 'ext', 'update', json_object('blob_id', id) FROM blob WHERE org_id = ?`,
      a.orgId,
    );
    expect(await repo.scheduleOrphan(a, D1)).toBe(schedules);
    expect((await rowOf(a, D1))?.purge_after === null).toBe(!schedules);
  });

  it('schedules only the requested digest', async () => {
    const repo = await orphan(8);
    await publish(repo, a, { sha256: D2 });
    await exec(`${DAYS_AGO(8)} WHERE org_id = ? AND sha256 = ?`, a.orgId, D2);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
    expect((await rowOf(a, D1))?.purge_after).not.toBeNull();
    expect((await rowOf(a, D2))?.purge_after).toBeNull();
  });

  it('without the re-put the forced deadline claims', async () => {
    const repo = await orphan(8);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
    await exec("UPDATE blob SET purge_after = '2000-01-01T00:00:00.000Z'");
    expect(await repo.claimPurge(a, D1)).toMatch(GEN);
  });

  it('keeps the deadline of an already scheduled row', async () => {
    const repo = await orphan(8);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
    await exec("UPDATE blob SET purge_after = '2001-01-01T00:00:00.000Z'");
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBe('2001-01-01T00:00:00.000Z');
  });

  it('refuses a leased row', async () => {
    const repo = await orphan(8);
    await exec(
      "UPDATE blob SET purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+600 seconds')",
    );
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
    await expireLease(a, D1);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
  });

  it('refuses a deleted row', async () => {
    const repo = await orphan(8);
    await exec("UPDATE blob SET deleted_at = '2000-01-01T00:00:00.000Z'");
    expect(await repo.scheduleOrphan(a, D1)).toBe(false);
    expect((await rowOf(a, D1))?.purge_after).toBeNull();
  });

  it('treats another organization as an absent key', async () => {
    const repo = await orphan(8);
    const before = await rowOf(a, D1);
    expect(await repo.scheduleOrphan(b, D1)).toBe(await repo.scheduleOrphan(b, D2));
    expect(await repo.scheduleOrphan(b, D1)).toBe(false);
    expect(await rowOf(a, D1)).toEqual(before);
    expect(await repo.scheduleOrphan(a, D1)).toBe(true);
  });

  it('validates the key before any statement runs', async () => {
    const counted = countCalls(executor);
    const repo = createBlobRepository(counted.executor);
    await expect(repo.scheduleOrphan(a, 'bad' as Sha256)).rejects.toBeInstanceOf(
      BlobValidationError,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});
