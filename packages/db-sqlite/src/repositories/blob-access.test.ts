import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createBlobAccessRepository } from './blob-access.js';

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

async function seed(org: OrgContext, id: string, accessedAt: string | null = null) {
  await executor.batch([
    {
      sql: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, last_accessed_at) VALUES (?, ?, ?, 1, ?, ?)',
      params: [id, org.orgId, id.padEnd(64, '0'), `k/${id}`, accessedAt],
    },
  ]);
}

async function accessed(id: string): Promise<string | null> {
  const [row] = await executor.all<{ last_accessed_at: string | null }>({
    sql: 'SELECT last_accessed_at FROM blob WHERE id = ?',
    params: [id],
  });
  return row?.last_accessed_at ?? null;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('blob access repository', () => {
  it('stamps a never-accessed blob and skips it on a second flush the same day', async () => {
    await seed(a, 'b1');
    const repo = createBlobAccessRepository(executor);
    expect(await repo.touch(a, ['b1'])).toBe(1);
    const first = await accessed('b1');
    expect(first).not.toBeNull();
    expect(await repo.touch(a, ['b1'])).toBe(0);
    expect(await accessed('b1')).toBe(first);
  });

  it('refreshes a blob last accessed more than a day ago', async () => {
    const old = daysAgo(2);
    await seed(a, 'b1', old);
    const repo = createBlobAccessRepository(executor);
    expect(await repo.touch(a, ['b1'])).toBe(1);
    expect(((await accessed('b1')) as string) > old).toBe(true);
  });

  it('never touches another organization', async () => {
    await seed(b, 'b1');
    const repo = createBlobAccessRepository(executor);
    expect(await repo.touch(a, ['b1'])).toBe(0);
    expect(await accessed('b1')).toBeNull();
  });

  it('uses one executor call and ignores empty, duplicate and unknown ids', async () => {
    await seed(a, 'b1');
    const counted = countCalls(executor);
    const repo = createBlobAccessRepository(counted.executor);
    expect(await repo.touch(a, [])).toBe(0);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    expect(await repo.touch(a, ['b1', 'b1', 'missing'])).toBe(1);
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });

  it('accepts exactly 200 ids and rejects 201 or malformed ids', async () => {
    const repo = createBlobAccessRepository(executor);
    const ids = Array.from({ length: 200 }, (_, i) => `x${i}`);
    await expect(repo.touch(a, ids)).resolves.toBe(0);
    await expect(repo.touch(a, [...ids, 'x200'])).rejects.toThrow();
    await expect(repo.touch(a, [''])).rejects.toThrow();
    await expect(repo.touch(a, [1 as unknown as string])).rejects.toThrow();
  });

  it('rejects a non-array argument', async () => {
    const repo = createBlobAccessRepository(executor);
    await expect(repo.touch(a, 'b1' as unknown as string[])).rejects.toThrow(TypeError);
  });

  it('does not stamp a tombstoned blob', async () => {
    await seed(a, 'b1');
    await executor.batch([
      {
        sql: "UPDATE blob SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'b1'",
        params: [],
      },
    ]);
    const repo = createBlobAccessRepository(executor);
    expect(await repo.touch(a, ['b1'])).toBe(0);
    expect(await accessed('b1')).toBeNull();
  });

  it('treats ids as data, not SQL', async () => {
    await seed(a, 'b1');
    const repo = createBlobAccessRepository(executor);
    expect(await repo.touch(a, [`"]') OR 1=1 --`])).toBe(0);
    expect(await accessed('b1')).toBeNull();
  });
});
