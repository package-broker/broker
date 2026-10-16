import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { assertGuard } from './kysely.js';
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

describe('assertGuard', () => {
  it('compiles to one statement with a single condition and a random key', () => {
    const first = assertGuard(condition(1));
    const second = assertGuard(condition(1));

    expect(first).toHaveLength(1);
    expect(first[0]?.sql).toBe(
      'with "guard_cond"("f") as materialized (select (select 1) is not 1 as "f"), "guard_rows"("n") as (select 1 as "n" union all select 2 as "n") ' +
        'insert into "access_mutation_guard" ("key") select ? as "key" from "guard_cond", "guard_rows" where "guard_cond"."f" = 1',
    );
    expect(first[0]?.params).toHaveLength(1);
    expect(first[0]?.params[0]).not.toBe(second[0]?.params[0]);
  });

  it('lets the mutation land and leaves no guard row when the condition is true', async () => {
    await database.executor.batch([...assertGuard(condition(1)), addUser('u-true')]);

    expect(await count("SELECT count(*) AS n FROM user_account WHERE id = 'u-true'")).toBe(1);
    expect(await count('SELECT count(*) AS n FROM access_mutation_guard')).toBe(0);
  });

  it.each([0, null] as const)(
    'fails with UNIQUE and rolls back when the condition is %s',
    async (value) => {
      await expect(
        database.executor.batch([
          addUser('u-before'),
          ...assertGuard(condition(value)),
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
      const [guard] = assertGuard(sql<boolean>`flip()`);
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
});
