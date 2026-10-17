import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { packageUpsertStatements } from './catalogue-write-package.js';
import {
  createFetchLeaseWriteGuard,
  createFetchLeases,
  fetchLeaseGuard,
  leaseKey,
} from './fetch-lease.js';

const A = '01J0WWWWWWWWWWWWWWWWWW0A01';
const B = '01J0WWWWWWWWWWWWWWWWWW0B01';
const C = '01J0WWWWWWWWWWWWWWWWWW0C01';
const PAST = '2000-01-01T00:00:00.000Z';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
});

afterEach(async () => {
  await database.close();
});

const parts = (key: string) => [org.orgId, 'dist', 'src', 'npm', key];

async function expire(key: string): Promise<void> {
  await database.executor.batch([
    stmt('UPDATE fetch_lease SET lease_until = ? WHERE lease_key = ?', PAST, key),
  ]);
}

describe('leaseKey', () => {
  it('3: a 214-character npm name and a legacy-case key give 64-character lowercase hex keys', async () => {
    const long = await leaseKey(parts(`@${'a'.repeat(106)}/${'b'.repeat(106)}`));
    const mixed = await leaseKey(parts('Legacy/Package'));
    for (const key of [long, mixed]) expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(mixed).not.toBe(await leaseKey(parts('legacy/package')));
    expect(await leaseKey(parts('x'))).toBe(await leaseKey(parts('x')));
  });

  it('separates tuples that would collide when joined', async () => {
    expect(await leaseKey(['a', 'bc'])).not.toBe(await leaseKey(['ab', 'c']));
  });
});

describe('fetch lease repository', () => {
  it('1: two acquires race to exactly one owner and a third takes over after expiry with fence + 1', async () => {
    const leases = createFetchLeases(database.executor);
    const key = await leaseKey(parts('acme/widget'));
    const results = await Promise.all([
      leases.acquire(org, key, A, 60),
      leases.acquire(org, key, B, 60),
    ]);
    const won = results.filter((r) => r !== 'held');
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r === 'held')).toHaveLength(1);
    const first = won[0];
    if (first === undefined) throw new Error('unreachable');
    expect(first).toMatchObject({ key, fence: 1 });

    expect(await leases.acquire(org, key, first.owner, 60)).toBe('held');

    await expire(key);
    const third = await leases.acquire(org, key, C, 60);
    expect(third).toEqual({ key, owner: C, fence: 2 });
  });

  it('renew extends only for the current owner and fence while unexpired', async () => {
    const leases = createFetchLeases(database.executor);
    const key = await leaseKey(parts('r'));
    const handle = await leases.acquire(org, key, A, 60);
    if (handle === 'held') throw new Error('unreachable');
    expect(await leases.renew(org, handle, 120)).toBe(true);
    expect(await leases.renew(org, { ...handle, fence: 2 }, 120)).toBe(false);
    expect(await leases.renew(org, { ...handle, owner: B }, 120)).toBe(false);
    expect(await leases.renew(other, handle, 120)).toBe(false);
    await expire(key);
    expect(await leases.renew(org, handle, 120)).toBe(false);
  });

  it('release frees the key for the next acquire and ignores a superseded handle', async () => {
    const leases = createFetchLeases(database.executor);
    const key = await leaseKey(parts('rel'));
    const old = await leases.acquire(org, key, A, 60);
    if (old === 'held') throw new Error('unreachable');
    await expire(key);
    const fresh = await leases.acquire(org, key, B, 60);
    if (fresh === 'held') throw new Error('unreachable');
    await leases.release(org, old);
    expect(await leases.acquire(org, key, C, 60)).toBe('held');
    await leases.release(org, fresh);
    expect(await leases.acquire(org, key, C, 60)).toMatchObject({ owner: C });
  });

  it('refuses to take over a key held by another organization', async () => {
    const leases = createFetchLeases(database.executor);
    const key = await leaseKey(parts('iso'));
    expect(await leases.acquire(org, key, A, 60)).not.toBe('held');
    await expire(key);
    expect(await leases.acquire(other, key, B, 60)).toBe('held');
  });

  it('rejects malformed keys, owners and durations', async () => {
    const leases = createFetchLeases(database.executor);
    const key = await leaseKey(parts('v'));
    await expect(leases.acquire(org, 'ABC', A, 60)).rejects.toThrow(RangeError);
    await expect(leases.acquire(org, key, '', 60)).rejects.toThrow(RangeError);
    await expect(leases.acquire(org, key, A, 0)).rejects.toThrow(RangeError);
    await expect(leases.acquire(org, key, A, 1.5)).rejects.toThrow(RangeError);
  });

  it('3: each acquire collects at most 20 rows expired for more than an hour', async () => {
    const leases = createFetchLeases(database.executor);
    const old: Statement[] = [];
    for (let i = 0; i < 25; i += 1) {
      old.push(
        stmt(
          "INSERT INTO fetch_lease (org_id, lease_key, owner, fence, lease_until, acquired_at) VALUES (?, ?, 'o', 1, ?, ?)",
          org.orgId,
          i.toString(16).padStart(64, '0'),
          PAST,
          PAST,
        ),
      );
    }
    const recent = new Date(Date.now() - 600_000).toISOString();
    old.push(
      stmt(
        "INSERT INTO fetch_lease (org_id, lease_key, owner, fence, lease_until, acquired_at) VALUES (?, ?, 'o', 1, ?, ?)",
        org.orgId,
        'f'.repeat(64),
        recent,
        recent,
      ),
    );
    await database.executor.batch(old);
    const count = async () =>
      (await database.executor.all<{ n: number }>(stmt('SELECT count(*) AS n FROM fetch_lease')))[0]
        ?.n;
    expect(await count()).toBe(26);
    await leases.acquire(org, await leaseKey(parts('gc1')), A, 60);
    expect(await count()).toBe(7);
    await leases.acquire(org, await leaseKey(parts('gc2')), A, 60);
    expect(await count()).toBe(3);
  });
});

describe('fetch lease write guard', () => {
  const SOURCE = '01J0SRC0000000000000000S01';
  const PROJECT = '01J0PRJ0000000000000000P01';

  beforeEach(async () => {
    await database.executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'npm', 'npm_registry')",
        SOURCE,
        org.orgId,
      ),
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'p1', 'P1')",
        PROJECT,
        org.orgId,
      ),
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        org.orgId,
        PROJECT,
        SOURCE,
      ),
    ]);
  });

  it.each(['expired', 'stolen', 'released and reacquired'] as const)(
    '2: a real catalogue batch with a %s lease rolls back earlier mutations',
    async (state) => {
      const leases = createFetchLeases(database.executor);
      const key = await leaseKey(parts('guarded'));
      const old = await leases.acquire(org, key, A, 60);
      if (old === 'held') throw new Error('unreachable');
      const input = {
        sourceId: SOURCE,
        ecosystem: 'npm' as const,
        key: 'widget',
        description: 'Live',
      };
      const live = packageUpsertStatements(org, createFetchLeaseWriteGuard(org, old), input);
      await database.executor.batch(live.statements);
      const packages = () =>
        database.executor.all(stmt('SELECT * FROM package WHERE org_id = ?', org.orgId));
      const memberships = () =>
        database.executor.all(stmt('SELECT * FROM project_package WHERE org_id = ?', org.orgId));
      const beforePackages = await packages();
      const beforeMemberships = await memberships();
      expect(beforePackages).toHaveLength(1);
      expect(beforePackages[0]).toMatchObject({ id: live.candidateId, description: 'Live' });
      expect(beforeMemberships).toHaveLength(1);

      if (state === 'released and reacquired') {
        await leases.release(org, old);
      } else {
        await expire(key);
      }
      if (state !== 'expired') {
        const next = await leases.acquire(org, key, B, 60);
        if (next === 'held') throw new Error('unreachable');
        expect(next).toEqual({ key, owner: B, fence: state === 'stolen' ? 2 : 1 });
        expect(old).toEqual({ key, owner: A, fence: 1 });
      }
      const stale = packageUpsertStatements(org, createFetchLeaseWriteGuard(org, old), {
        ...input,
        key: 'stale-widget',
      });
      await expect(
        database.executor.batch([
          stmt(
            "UPDATE package SET description = 'Changed before guard' WHERE org_id = ?",
            org.orgId,
          ),
          ...stale.statements,
        ]),
      ).rejects.toThrow();
      expect(await packages()).toEqual(beforePackages);
      expect(await memberships()).toEqual(beforeMemberships);
    },
  );

  it('fails when the lease has expired or belongs to another organization', async () => {
    const leases = createFetchLeases(database.executor);
    const key = await leaseKey(parts('exp'));
    const handle = await leases.acquire(org, key, A, 60);
    if (handle === 'held') throw new Error('unreachable');
    await expect(database.executor.batch([...fetchLeaseGuard(other, handle)])).rejects.toThrow();
    await expire(key);
    await expect(database.executor.batch([...fetchLeaseGuard(org, handle)])).rejects.toThrow();
  });
});
