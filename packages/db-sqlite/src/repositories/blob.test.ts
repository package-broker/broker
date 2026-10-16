import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
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

async function exec(sql: string, ...params: (string | number)[]): Promise<void> {
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

async function due(org: OrgContext, sha: Sha256): Promise<void> {
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
  it('inserts the row and reads it back through find and inspect', async () => {
    const repo = createBlobRepository(executor);
    const { info } = await publish(repo);
    expect(info).toEqual({ sha256: D1, size: 10, mediaType: 'application/zip', purgeAfter: null });
    expect(await repo.find(a, D1)).toEqual(info);
    expect(await repo.inspect(a, D1)).toEqual({ info, purging: false });
    const stored = await rows<{ storage_key: string }>('SELECT storage_key FROM blob');
    expect(stored[0]?.storage_key).toMatch(/^sha256\/[0-9a-f]+\/aa\/a+$/);
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

  it('claimPurge needs a due purge_after', async () => {
    const repo = createBlobRepository(executor);
    expect(await repo.claimPurge(a, D1)).toBeNull();
    await publish(repo);
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
