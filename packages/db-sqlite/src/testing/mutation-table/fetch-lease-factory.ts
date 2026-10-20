import { expect } from 'vitest';
import { createFetchLeases } from '../../repositories/fetch-lease.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ALWAYS, HASH, NOT_NULL, OTHER_HASH, OWNER, FUTURE } from './fixtures.js';
import { executing } from './factory-cases.js';

const EXPIRED = '2000-01-01T00:00:00.000Z';
const SECOND_OWNER = '01J0WWWWWWWWWWWWWWWWWW0M02';

const leases = (context: Parameters<ContractCase['run']>[0]) =>
  context.executor.all({
    sql: 'SELECT org_id, lease_key, owner, fence, lease_until FROM fetch_lease ORDER BY lease_key',
    params: [],
  });

const foreignRelease: ContractCase = {
  name: 'lease release preserves a foreign lease',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      'INSERT INTO fetch_lease (org_id, lease_key, owner, fence, lease_until, acquired_at) VALUES (?, ?, ?, 3, ?, ?)',
      foreign.orgId,
      HASH,
      OWNER,
      FUTURE,
      FUTURE,
    );
    await createFetchLeases(executing(context)).release(own, { key: HASH, owner: OWNER, fence: 3 });
    expect(await leases(context)).toEqual([
      { org_id: foreign.orgId, lease_key: HASH, owner: OWNER, fence: 3, lease_until: FUTURE },
    ]);
  },
};

const foreignRenew: ContractCase = {
  name: 'lease renew preserves a foreign lease',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      'INSERT INTO fetch_lease (org_id, lease_key, owner, fence, lease_until, acquired_at) VALUES (?, ?, ?, 3, ?, ?)',
      foreign.orgId,
      HASH,
      OWNER,
      FUTURE,
      FUTURE,
    );
    expect(
      await createFetchLeases(executing(context)).renew(
        own,
        { key: HASH, owner: OWNER, fence: 3 },
        60,
      ),
    ).toBe(false);
    expect(await leases(context)).toEqual([
      { org_id: foreign.orgId, lease_key: HASH, owner: OWNER, fence: 3, lease_until: FUTURE },
    ]);
  },
};

const foreignTakeover: ContractCase = {
  name: 'lease acquire does not take over a foreign expired lease',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      'INSERT INTO fetch_lease (org_id, lease_key, owner, fence, lease_until, acquired_at) VALUES (?, ?, ?, 3, ?, ?)',
      foreign.orgId,
      HASH,
      OWNER,
      EXPIRED,
      EXPIRED,
    );
    expect(await createFetchLeases(executing(context)).acquire(own, HASH, SECOND_OWNER, 60)).toBe(
      'held',
    );
    expect(await leases(context)).toEqual([
      { org_id: foreign.orgId, lease_key: HASH, owner: OWNER, fence: 3, lease_until: EXPIRED },
    ]);
  },
};

const foreignCollect: ContractCase = {
  name: 'lease acquire collects only its own expired leases',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    const stale = 'c'.repeat(64);
    await seed(
      'INSERT INTO fetch_lease (org_id, lease_key, owner, fence, lease_until, acquired_at) VALUES (?, ?, ?, 3, ?, ?), (?, ?, ?, 3, ?, ?)',
      foreign.orgId,
      OTHER_HASH,
      OWNER,
      EXPIRED,
      EXPIRED,
      own.orgId,
      stale,
      OWNER,
      EXPIRED,
      EXPIRED,
    );
    expect(
      await createFetchLeases(executing(context)).acquire(own, HASH, SECOND_OWNER, 60),
    ).toMatchObject({ key: HASH, owner: SECOND_OWNER, fence: 1 });
    expect((await leases(context)).map((row) => row.lease_key)).toEqual([HASH, OTHER_HASH]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/fetch-lease.ts',
    builder: 'createFetchLeases',
    cases: [foreignRelease, foreignRenew, foreignTakeover, foreignCollect],
    predicates: [
      {
        name: foreignRelease.name,
        caseName: foreignRelease.name,
        locate: /(?<=delete from "fetch_lease" where "lease_key" = \? and )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      {
        name: foreignRenew.name,
        caseName: foreignRenew.name,
        locate: /(?<=update "fetch_lease" set [^]*?"lease_key" = \? and )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      {
        name: foreignTakeover.name,
        caseName: foreignTakeover.name,
        locate: /fetch_lease\.org_id = excluded\.org_id/,
        neutral: ALWAYS,
        copies: 1,
      },
      {
        name: foreignCollect.name,
        caseName: foreignCollect.name,
        locate: /(?<=select "lease_key" from "fetch_lease" where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
    ],
  },
];
