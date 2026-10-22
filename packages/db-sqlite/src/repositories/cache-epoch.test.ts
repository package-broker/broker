import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import type { Cache, CacheEventCode } from '@package-broker/core/platform/cache';
import { createScopedCache, defaultEntry } from '@package-broker/core/platform/cache';
import { countCalls } from '../contract/count-calls.js';
import { seedTwoOrganizations, type TwoOrganizations } from '../contract/two-organizations.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { createCacheEpochRepository, epochReadStatement } from './cache-epoch.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

const MISSING = orgContext('01J0NONE000000000000000000');
const TOKEN = /^[0-9A-F]{32}$/;

let opened: OpenedExecutor;
let orgs: TwoOrganizations;

async function run(sql: string, params: (string | number)[] = []): Promise<void> {
  await opened.executor.batch([{ sql, params }]);
}

async function stored(orgId: string): Promise<string> {
  const rows = await opened.executor.all<{ version: string }>({
    sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
    params: [orgId],
  });
  return rows[0]?.version ?? '';
}

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
  const init = await loadMigrationSource('core', '0001_init.sql', read('0001_init.sql'));
  await migrate(opened.executor, [init], { holder: 't273' });
  orgs = await seedTwoOrganizations(opened.executor);
});

afterEach(async () => {
  await opened.close();
});

describe('createCacheEpochRepository', () => {
  it('1: read returns the seeded random token', async () => {
    const version = await createCacheEpochRepository(opened.executor).read(orgs.a);

    expect(version).toMatch(TOKEN);
    expect(version).toBe(await stored(orgs.a.orgId));
  });

  it('2: read resolves null for a missing row and inserts nothing', async () => {
    const repository = createCacheEpochRepository(opened.executor);

    expect(await repository.read(MISSING)).toBeNull();

    expect(await stored(MISSING.orgId)).toBe('');
  });

  it('3: read resolves null when the row was deleted after seeding', async () => {
    await run('DELETE FROM cache_epoch WHERE org_id = ?', [orgs.a.orgId]);

    expect(await createCacheEpochRepository(opened.executor).read(orgs.a)).toBeNull();
  });

  it('4: read propagates an executor failure', async () => {
    const failing: ScalarSqlExecutor = {
      driver: opened.executor.driver,
      all: async () => {
        throw new Error('read failed');
      },
      batch: async () => {
        throw new Error('read failed');
      },
    };

    await expect(createCacheEpochRepository(failing).read(orgs.a)).rejects.toThrow('read failed');
  });

  it('5: the same instance observes a new version written by SQL (no caching)', async () => {
    const repository = createCacheEpochRepository(opened.executor);
    const before = await repository.read(orgs.a);

    await run('UPDATE cache_epoch SET version = hex(randomblob(16)) WHERE org_id = ?', [
      orgs.a.orgId,
    ]);

    const after = await repository.read(orgs.a);
    expect(after).toMatch(TOKEN);
    expect(after).not.toBe(before);
  });

  it('6: exposes no bump', () => {
    expect('bump' in createCacheEpochRepository(opened.executor)).toBe(false);
  });

  it('7: each read is one executor call', async () => {
    const counted = countCalls(opened.executor);

    await createCacheEpochRepository(counted.executor).read(orgs.a);

    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });

  it('8: two organizations have independent versions and the other org row is never returned', async () => {
    const repository = createCacheEpochRepository(opened.executor);
    const b = await repository.read(orgs.b);
    await run('UPDATE cache_epoch SET version = hex(randomblob(16)) WHERE org_id = ?', [
      orgs.a.orgId,
    ]);

    expect(await repository.read(orgs.b)).toBe(b);
    expect(await repository.read(orgs.a)).toBe(await stored(orgs.a.orgId));
    expect(await repository.read(orgs.a)).not.toBe(b);
    await run('DELETE FROM cache_epoch WHERE org_id = ?', [orgs.a.orgId]);
    expect(await repository.read(orgs.a)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['short', 'ABCDEF'],
    ['lower-case', 'abcdefabcdefabcdefabcdefabcdefab'],
    ['non-hex', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
  ])('9: %s stored version raises a DbError with a code', async (_name, value) => {
    await run('UPDATE cache_epoch SET version = ? WHERE org_id = ?', [value, orgs.a.orgId]);

    const failure = await createCacheEpochRepository(opened.executor)
      .read(orgs.a)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(DbError);
    expect((failure as DbError).message).toBe('cache_epoch_invalid');
  });

  it('10: epochReadStatement is a batchable statement returning the version', async () => {
    const statement = epochReadStatement(orgs.a);

    const [result] = await opened.executor.batch([statement]);

    expect(result?.rows).toEqual([{ version: await stored(orgs.a.orgId) }]);
  });
});

describe('integration with createScopedCache', () => {
  const key = { projectId: 'p', sourceId: 's', kind: 'metadata', resource: 'r' } as const;
  const entry = defaultEntry('metadata', new Uint8Array([1]), new Date());
  const origin = { status: 200, authenticated: true, authorized: true };

  function harness(executor: ScalarSqlExecutor) {
    const calls = { get: 0, set: 0 };
    const events: CacheEventCode[] = [];
    const raw: Cache = {
      get: async () => {
        calls.get += 1;
        return null;
      },
      set: async (): Promise<void> => {
        calls.set += 1;
      },
      delete: async () => undefined,
    };
    const cache = createScopedCache(raw, createCacheEpochRepository(executor), {
      deploymentId: 'd1',
      onEvent: (code) => events.push(code),
    });
    return { cache, calls, events };
  }

  it('11: a missing row emits epoch_missing and neither reads nor fills', async () => {
    const { cache, calls, events } = harness(opened.executor);

    const got = await cache.get(MISSING, key);
    const set = await cache.set(MISSING, key, entry, { expectedVersion: 'x', origin });

    expect(got).toEqual({ hit: null, version: null });
    expect(set).toBe('bypassed');
    expect(events).toContain('epoch_missing');
    expect(calls).toEqual({ get: 0, set: 0 });
  });

  it('12: an invalid stored version emits epoch_error and bypasses', async () => {
    await run('UPDATE cache_epoch SET version = ? WHERE org_id = ?', ['', orgs.a.orgId]);
    const { cache, calls, events } = harness(opened.executor);

    const got = await cache.get(orgs.a, key);

    expect(got).toEqual({ hit: null, version: null });
    expect(events).toContain('epoch_error');
    expect(calls).toEqual({ get: 0, set: 0 });
  });

  it('13: an executor failure emits epoch_error and neither reads nor fills', async () => {
    const failing: ScalarSqlExecutor = {
      driver: opened.executor.driver,
      all: async () => {
        throw new Error('down');
      },
      batch: async () => {
        throw new Error('down');
      },
    };
    const { cache, calls, events } = harness(failing);

    const got = await cache.get(orgs.a, key);
    const set = await cache.set(orgs.a, key, entry, { expectedVersion: 'x', origin });

    expect(got).toEqual({ hit: null, version: null });
    expect(set).toBe('bypassed');
    expect(events).toContain('epoch_error');
    expect(calls).toEqual({ get: 0, set: 0 });
  });

  it('14: a healthy row reads and fills under the current version', async () => {
    const { cache, calls } = harness(opened.executor);

    const got = await cache.get(orgs.a, key);
    const set = await cache.set(orgs.a, key, entry, {
      expectedVersion: got.version ?? '',
      origin,
    });

    expect(got.version).toBe(await stored(orgs.a.orgId));
    expect(set).toBe('stored');
    expect(calls).toEqual({ get: 1, set: 1 });
  });
});
