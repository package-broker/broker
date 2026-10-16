import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { cacheEpochBumpStatements } from './cache-epoch-bump.js';
import { jobLeaseGuard } from './job-lease-guard.js';

const JOB_ID = '01J0JOB00000000000000000A1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0001';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

let database: MigratedDatabase;
let org: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
});

afterEach(async () => {
  await database.close();
});

async function seedJob(
  overrides: { state?: string; leaseUntil?: string; owner?: string; fence?: number } = {},
): Promise<void> {
  await database.executor.batch([
    {
      sql: `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
        VALUES (?, ?, 'demo:work:v1', ?, ?, ?, ?, ?)`,
      params: [
        JOB_ID,
        org.orgId,
        `k:${JOB_ID}`,
        overrides.state ?? 'running',
        overrides.owner ?? OWNER,
        overrides.leaseUntil ?? FUTURE,
        overrides.fence ?? 3,
      ],
    },
  ]);
}

function addUser(id: string): Statement {
  return {
    sql: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    params: [id, org.orgId, `${id}@example.test`, 'active'],
  };
}

async function userCount(): Promise<number> {
  const rows = await database.executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM user_account',
    params: [],
  });
  return rows[0]?.n ?? -1;
}

async function epoch(): Promise<string | undefined> {
  const rows = await database.executor.all<{ version: string }>({
    sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
    params: [org.orgId],
  });
  return rows[0]?.version;
}

const live = { id: JOB_ID, owner: OWNER, fence: 3 };

describe('jobLeaseGuard', () => {
  it('commits the batch for the live owner', async () => {
    await seedJob();
    const before = await userCount();
    await database.executor.batch([...jobLeaseGuard(org, live), addUser('u-live')]);
    expect(await userCount()).toBe(before + 1);
  });

  it.each([
    ['fence advanced', { ...live, fence: 4 }, {}],
    ['wrong owner', { ...live, owner: '01J0WWWWWWWWWWWWWWWWWW0002' }, {}],
    ['lease expired', live, { leaseUntil: PAST }],
    ['job not running', live, { state: 'queued' }],
    ['unknown job', { ...live, id: '01J0JOB00000000000000000A2' }, {}],
  ])('rolls the batch back: %s', async (_name, guard, seed) => {
    await seedJob(seed);
    const before = await userCount();
    await expect(
      database.executor.batch([
        addUser('u-before'),
        ...jobLeaseGuard(org, guard),
        addUser('u-refused'),
      ]),
    ).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await userCount()).toBe(before);
  });

  it('rolls back for another organization', async () => {
    await seedJob();
    if (database.orgs === null) throw new Error('organizations were not seeded');
    const before = await userCount();
    await expect(
      database.executor.batch([
        addUser('u-before'),
        ...jobLeaseGuard(database.orgs.b, live),
        addUser('u-foreign'),
      ]),
    ).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await userCount()).toBe(before);
  });

  it('rejects malformed guards before building SQL', () => {
    expect(() => jobLeaseGuard(org, { ...live, fence: 0 })).toThrow(RangeError);
    expect(() => jobLeaseGuard(org, { ...live, id: '' })).toThrow(RangeError);
  });
});

describe('cacheEpochBumpStatements', () => {
  it('changes the epoch on commit', async () => {
    const before = await epoch();
    await database.executor.batch([...cacheEpochBumpStatements(org), addUser('u-bump')]);
    const after = await epoch();
    expect(after).toMatch(/^[0-9A-F]{32}$/);
    expect(after).not.toBe(before);
  });

  it('rolls back with the batch', async () => {
    const before = await epoch();
    const dup = addUser('u-dup');
    await database.executor.batch([dup]);
    await expect(database.executor.batch([...cacheEpochBumpStatements(org), dup])).rejects.toThrow(
      /UNIQUE|constraint/i,
    );
    expect(await epoch()).toBe(before);
  });

  it('fails the batch when the epoch row is missing', async () => {
    await database.executor.batch([
      { sql: 'DELETE FROM cache_epoch WHERE org_id = ?', params: [org.orgId] },
    ]);
    const before = await userCount();
    await expect(
      database.executor.batch([
        addUser('u-before'),
        ...cacheEpochBumpStatements(org),
        addUser('u-missing'),
      ]),
    ).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await userCount()).toBe(before);
  });
});

describe('module imports', () => {
  it.each(['job-lease-guard.ts', 'cache-epoch-bump.ts'])(
    '%s avoids contract and vitest',
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*(['"])([^'"]+)\1/g)].map(
        (match) => match[2] ?? '',
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/contract|vitest/);
      }
    },
  );
});
