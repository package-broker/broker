import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import {
  authContractCases,
  describeAuthContract,
  weakenStatements,
  type OpenedAuthDatabase,
} from './auth-contract.js';

async function openFile(): Promise<OpenedAuthDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-auth-contract-'));
  const path = join(directory, 'contract.sqlite');
  const connections: OpenedExecutor[] = [openNodeSqliteExecutor(path)];
  const [first] = connections;
  if (first === undefined) throw new Error('no connection');
  return {
    executor: first.executor,
    async second() {
      const extra = openNodeSqliteExecutor(path);
      connections.push(extra);
      return extra.executor;
    },
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describeAuthContract('node:sqlite', openFile);

type Rewrite = (statement: Statement) => Statement;

function neutralize(clause: string, params: number): Rewrite {
  const replacement = `(${Array.from({ length: params }, () => '? is not null').join(' and ') || '1 = 1'})`;
  return (statement) => ({
    sql: statement.sql.replaceAll(clause, replacement),
    params: statement.params,
  });
}

function unguarded(prefix: string, sql: string, keep: number): Rewrite {
  return (statement) =>
    statement.sql.startsWith(prefix) ? { sql, params: statement.params.slice(0, keep) } : statement;
}

function dropCheck(marker: string): Rewrite {
  return (statement) =>
    statement.sql.startsWith('with "guard_cond"') && statement.sql.includes(marker)
      ? { sql: 'select 1 where 0', params: [] }
      : statement;
}

function only(prefixes: string[], rewrite: Rewrite): Rewrite {
  return (statement) =>
    prefixes.some((prefix) => statement.sql.startsWith(prefix)) ? rewrite(statement) : statement;
}

function all(...rewrites: Rewrite[]): Rewrite {
  return (statement) => rewrites.reduce((current, rewrite) => rewrite(current), statement);
}

const ownsIdentity =
  'exists (select 1 as "one" from "identity" as "guard_identity" where "guard_identity"."org_id" = ? and "guard_identity"."provider" = ? and "guard_identity"."subject" = ? and "guard_identity"."user_id" = ?)';
const plannedIdentity =
  'exists (select 1 as "one" from "identity" where "identity"."id" = ? and "identity"."org_id" = ? and "identity"."provider" = ? and "identity"."subject" = ? and "identity"."user_id" = ?)';
const singleSubject =
  'not exists (select 1 as "one" from "identity" where "identity"."org_id" = ? and "identity"."user_id" = ? and "identity"."provider" = ? and "identity"."subject" <> ?)';

describe('weakened guards are caught by the contract cases', () => {
  const weaken =
    (rewrite: Rewrite) =>
    (executor: SqlExecutor): SqlExecutor =>
      weakenStatements(executor, rewrite);

  const cases: {
    name: string;
    run: keyof typeof authContractCases;
    rewrite: Rewrite;
    failure: RegExp;
  }[] = [
    {
      name: 'a replay without the step guard leaves two sessions',
      run: 'totpReplay',
      rewrite: neutralize('"local_login"."totp_last_step" < ?', 1),
      failure: /to have a length of 1 but got 2/,
    },
    {
      name: 'a success without the snapshot guards survives a reset',
      run: 'resetRace',
      rewrite: all(
        neutralize('"local_login"."credential_rev" = ?', 1),
        neutralize('"local_login"."password_hash" = ?', 1),
        neutralize('"local_login"."totp_credential_id" = ?', 1),
        neutralize('"local_login"."totp_enabled_at" is not null', 0),
      ),
      failure: /success after reset: expected true to be false/,
    },
    {
      name: 'a completion without the credential guard wins against a restage',
      run: 'setupRestage',
      rewrite: neutralize('"totp_credential_id" = ? and "credential_rev" = ?', 2),
      failure: /to have a length of 1 but got 2/,
    },
    {
      name: 'a login without the ownership guard on its group writes replaces the groups of its own user',
      run: 'loginBatchRace',
      rewrite: only(
        ['delete from "user_group"', 'insert into "user_group"'],
        all(neutralize(ownsIdentity, 4), neutralize(plannedIdentity, 5)),
      ),
      failure: /refused login leaves state: expected/,
    },
    {
      name: 'a login without the already-linked guard links two subjects at one provider',
      run: 'loginBatchRace',
      rewrite: neutralize(singleSubject, 4),
      failure: /user already linked at the provider: expected 'created' to be 'refused'/,
    },
    {
      name: 'a reservation without the lock guard lets all six attempts through',
      run: 'reserveAttempt',
      rewrite: neutralize('"local_login"."locked_until" <= ?', 1),
      failure: /to have a length of 5 but got 6/,
    },
    {
      name: 'a grant delete without the holder guard removes the last holder',
      run: 'lastAdminRaces',
      rewrite: dropCheck('"access_grant" as "pg"'),
      failure: /delete against delete: expected/,
    },
    {
      name: 'a suspension without the holder guard suspends both holders',
      run: 'lastAdminRaces',
      rewrite: unguarded(
        'update "user_account" set "status"',
        'update "user_account" set "status" = ?, "updated_at" = ? where "user_account"."id" = ? and "user_account"."org_id" = ? and "user_account"."status" = ? returning "id"',
        5,
      ),
      failure: /suspend against suspend: expected/,
    },
  ];

  for (const { name, run, rewrite, failure } of cases) {
    it(
      name,
      async () => {
        await expect(authContractCases[run](openFile, weaken(rewrite))).rejects.toThrow(failure);
      },
      60_000,
    );
  }
});
