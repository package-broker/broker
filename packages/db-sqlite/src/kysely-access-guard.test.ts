import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedTokenActor,
  type AuthenticatedActor,
  type FenceGuard,
} from '@package-broker/core/authz/fence';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { assertCheck, assertGuard, runOrgFenced } from './kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

let database: MigratedDatabase;
let org: OrgContext;
let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pb-access-guard-'));
  path = join(directory, 'guard.sqlite');
  database = await openMigratedDatabase({ twoOrganizations: true, file: path });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
});

afterEach(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

function addUser(id: string): Statement {
  return {
    sql: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    params: [id, org.orgId, `${id}@example.test`, 'active'],
  };
}

async function count(query: string): Promise<number> {
  const rows = await database.executor.all<{ n: number }>({ sql: query, params: [] });
  return rows[0]?.n ?? -1;
}

const condition = (value: 0 | 1 | null) => sql<boolean>`(select ${sql.lit(value)})`;

describe('assertCheck', () => {
  it('is one statement that never touches cache_epoch', async () => {
    const check = assertCheck(condition(1));
    expect(check).toHaveLength(1);
    expect(check[0]?.sql).not.toContain('cache_epoch');
    const before = await database.executor.all({ sql: 'SELECT * FROM cache_epoch', params: [] });
    await database.executor.batch([...check, addUser('u-check')]);
    expect(await database.executor.all({ sql: 'SELECT * FROM cache_epoch', params: [] })).toEqual(
      before,
    );
  });
});

describe('assertGuard', () => {
  it('compiles to the guard, the epoch bump and the single-row check, with a random key', () => {
    const first = assertGuard(condition(1), org);
    const second = assertGuard(condition(1), org);

    expect(first).toHaveLength(3);
    expect(first[0]?.sql).toBe(
      'with "guard_cond"("f") as materialized (select (select 1) is not 1 as "f"), "guard_rows"("n") as (select 1 as "n" union all select 2 as "n") ' +
        'insert into "access_mutation_guard" ("key") select ? as "key" from "guard_cond", "guard_rows" where "guard_cond"."f" = 1',
    );
    expect(first[0]?.params).toHaveLength(1);
    expect(first[0]?.params[0]).not.toBe(second[0]?.params[0]);
    expect(first[1]?.sql).toBe(
      'update "cache_epoch" set "version" = hex(randomblob(16)) where "org_id" = ?',
    );
    expect(first[1]?.params).toEqual([org.orgId]);
  });

  it('lets the mutation land and leaves no guard row when the condition is true', async () => {
    await database.executor.batch([...assertGuard(condition(1), org), addUser('u-true')]);

    expect(await count("SELECT count(*) AS n FROM user_account WHERE id = 'u-true'")).toBe(1);
    expect(await count('SELECT count(*) AS n FROM access_mutation_guard')).toBe(0);
  });

  it.each([0, null] as const)(
    'fails with UNIQUE and rolls back when the condition is %s',
    async (value) => {
      await expect(
        database.executor.batch([
          addUser('u-before'),
          ...assertGuard(condition(value), org),
          addUser('u-after'),
        ]),
      ).rejects.toMatchObject({ kind: 'unique' });

      expect(await count("SELECT count(*) AS n FROM user_account WHERE id LIKE 'u-%'")).toBe(0);
      expect(await count('SELECT count(*) AS n FROM access_mutation_guard')).toBe(0);
    },
  );

  it('evaluates the condition once even when the function changes value between calls', () => {
    const raw = new DatabaseSync(path);
    try {
      let calls = 0;
      raw.function('flip', { deterministic: false }, () => {
        calls += 1;
        return calls === 1 ? 0 : 1;
      });
      const [guard] = assertGuard(sql<boolean>`flip()`, org);
      if (guard === undefined) throw new Error('missing guard');

      raw.exec('BEGIN');
      let failure: unknown;
      try {
        raw.prepare(guard.sql).run(...(guard.params as string[]));
      } catch (error) {
        failure = error;
      }
      raw.exec('ROLLBACK');

      expect(String(failure)).toContain('UNIQUE');
      expect(calls).toBe(1);
      expect(raw.prepare('SELECT count(*) AS n FROM access_mutation_guard').get()).toEqual({
        n: 0,
      });
    } finally {
      raw.close();
    }
  });

  describe('cache_epoch bump', () => {
    const versionOf = async (orgId: string): Promise<string | null> => {
      const rows = await database.executor.all<{ version: string }>({
        sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
        params: [orgId],
      });
      return rows[0]?.version ?? null;
    };

    it('changes the version exactly once, to 32 uppercase hex characters, only for that organization', async () => {
      const other = database.orgs?.b;
      if (other === undefined) throw new Error('second organization missing');
      const before = await versionOf(org.orgId);
      const otherBefore = await versionOf(other.orgId);

      await database.executor.batch([...assertGuard(condition(1), org), addUser('u-bump')]);

      const after = await versionOf(org.orgId);
      expect(after).toMatch(/^[0-9A-F]{32}$/);
      expect(after).not.toBe(before);
      expect(await versionOf(other.orgId)).toBe(otherBefore);
    });

    it('leaves the version unchanged when the guard refuses', async () => {
      const before = await versionOf(org.orgId);
      await expect(
        database.executor.batch([...assertGuard(condition(0), org), addUser('u-refused')]),
      ).rejects.toMatchObject({ kind: 'unique' });
      expect(await versionOf(org.orgId)).toBe(before);
    });

    it('rolls the bump back when a later statement fails', async () => {
      const before = await versionOf(org.orgId);
      await expect(
        database.executor.batch([
          ...assertGuard(condition(1), org),
          addUser('u-dup'),
          addUser('u-dup'),
        ]),
      ).rejects.toMatchObject({ kind: 'unique' });
      expect(await versionOf(org.orgId)).toBe(before);
      expect(await count("SELECT count(*) AS n FROM user_account WHERE id = 'u-dup'")).toBe(0);
    });

    it('fails closed and stores nothing when the organization has no cache_epoch row', async () => {
      await database.executor.all({
        sql: 'DELETE FROM cache_epoch WHERE org_id = ?',
        params: [org.orgId],
      });

      await expect(
        database.executor.batch([...assertGuard(condition(1), org), addUser('u-missing')]),
      ).rejects.toMatchObject({ kind: 'unique' });

      expect(await count("SELECT count(*) AS n FROM user_account WHERE id = 'u-missing'")).toBe(0);
      expect(await versionOf(org.orgId)).toBeNull();
      expect(await count('SELECT count(*) AS n FROM access_mutation_guard')).toBe(0);
    });
  });
});

describe('runOrgFenced', () => {
  const fence = () =>
    mutationFence({ userId: 'u', sessionId: 's' } as unknown as AuthenticatedActor, {});
  const run = (guard: FenceGuard, mutations: Statement[], ctx = org) =>
    runOrgFenced(database.executor, ctx, fence(), guard, mutations, {});

  it('commits the mutations with the guard', async () => {
    const outcome = await run(assertGuard(condition(1), org), [addUser('u-ok')]);
    expect(outcome.ok).toBe(true);
    expect(await count("SELECT count(*) AS n FROM user_account WHERE id = 'u-ok'")).toBe(1);
  });

  it('refuses a guard built for another organization and stores nothing', async () => {
    const other = database.orgs?.b;
    if (other === undefined) throw new Error('second organization missing');
    await expect(run(assertGuard(condition(1), other), [addUser('u-foreign')])).rejects.toThrow(
      TypeError,
    );
    expect(await count('SELECT count(*) AS n FROM user_account')).toBe(0);
  });

  const tokenFence = () =>
    tokenMutationFence(
      { tokenId: 'token', tokenKind: 'pat', principalId: 'u' } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
  it('commits a token fence with a guard built for the organization', async () => {
    const outcome = await runOrgFenced(
      database.executor,
      org,
      tokenFence(),
      assertGuard(condition(1), org),
      [addUser('u-token')],
      {},
    );
    expect(outcome.ok).toBe(true);
    expect(await count("SELECT count(*) AS n FROM user_account WHERE id = 'u-token'")).toBe(1);
  });
  it('refuses a token fence guard built for another organization and stores nothing', async () => {
    const other = database.orgs?.b;
    if (other === undefined) throw new Error('second organization missing');
    await expect(
      runOrgFenced(
        database.executor,
        org,
        tokenFence(),
        assertGuard(condition(1), other),
        [addUser('u-token-foreign')],
        {},
      ),
    ).rejects.toThrow(TypeError);
    expect(await count('SELECT count(*) AS n FROM user_account')).toBe(0);
  });
  it('refuses a token mutation touching cache_epoch and stores nothing', async () => {
    await expect(
      runOrgFenced(
        database.executor,
        org,
        tokenFence(),
        assertGuard(condition(1), org),
        [
          addUser('u-token-bump'),
          {
            sql: 'UPDATE cache_epoch SET version = ? WHERE org_id = ?',
            params: ['x', org.orgId],
          },
        ],
        {},
      ),
    ).rejects.toThrow(TypeError);
    expect(await count('SELECT count(*) AS n FROM user_account')).toBe(0);
  });

  it('refuses a guard that assertGuard did not build', async () => {
    await expect(run(assertCheck(condition(1)) as FenceGuard, [addUser('u-raw')])).rejects.toThrow(
      TypeError,
    );
    expect(await count('SELECT count(*) AS n FROM user_account')).toBe(0);
  });

  it('rejects mutations that update cache_epoch', async () => {
    const bump: Statement = {
      sql: 'UPDATE cache_epoch SET version = ? WHERE org_id = ?',
      params: ['x', org.orgId],
    };
    await expect(run(assertGuard(condition(1), org), [addUser('u-bump'), bump])).rejects.toThrow(
      TypeError,
    );
    expect(await count('SELECT count(*) AS n FROM user_account')).toBe(0);
  });

  it('throws the deployment fault when the cache_epoch row is missing', async () => {
    await database.executor.all({
      sql: 'DELETE FROM cache_epoch WHERE org_id = ?',
      params: [org.orgId],
    });
    await expect(run(assertGuard(condition(1), org), [addUser('u-gone')])).rejects.toThrow(
      /cache_epoch/,
    );
    expect(await count('SELECT count(*) AS n FROM user_account')).toBe(0);
  });

  it('reports a refused guard as a failed outcome while the epoch row exists', async () => {
    const outcome = await run(assertGuard(condition(0), org), [addUser('u-no')]);
    expect(outcome.ok).toBe(false);
  });
});
