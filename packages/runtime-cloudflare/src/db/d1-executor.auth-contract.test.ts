import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { classifySqliteError, DbError } from '@package-broker/core/db/errors';
import type { ScalarStatement, SqlExecutor } from '@package-broker/core/db/port';
import { describeAuthContract } from '@package-broker/db-sqlite/contract/auth-contract';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { seedDefaultsStatements } from '@package-broker/db-sqlite/repositories/role';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const BRIDGE_SCRIPT = `
const decode = (value) =>
  value !== null && typeof value === 'object'
    ? Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0))
    : value;
export default {
  async fetch(request, env) {
    const { binding, mode, statements } = await request.json();
    try {
      const prepared = statements.map(({ sql, params }) =>
        env[binding].prepare(sql).bind(...params.map(decode)),
      );
      const result = mode === 'all' ? [await prepared[0].all()] : await env[binding].batch(prepared);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({
        ok: false,
        message: String(error && error.message),
        cause: error && error.cause ? String(error.cause.message) : null,
      });
    }
  },
};
`;

const bindings = Array.from({ length: 64 }, (_, index) => `MDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: BRIDGE_SCRIPT,
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

function allocateBinding(): string {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  return binding;
}

async function database(): Promise<D1DatabaseLike> {
  return (await mf.getD1Database(allocateBinding())) as unknown as D1DatabaseLike;
}

type Send = (mode: 'all' | 'batch', statements: BridgedStatement[]) => Promise<unknown[]>;

class BridgedStatement {
  constructor(
    readonly sql: string,
    readonly params: readonly unknown[],
    private readonly send: Send,
  ) {}

  bind(...params: unknown[]): BridgedStatement {
    return new BridgedStatement(this.sql, params, this.send);
  }

  async all(): Promise<unknown> {
    return (await this.send('all', [this]))[0];
  }
}

function encodeParam(value: unknown): unknown {
  return value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value;
}

// Statements are prepared and bound inside workerd; the Node-side prepare/bind
// calls are synchronous Miniflare RPCs that block the main thread.
function bridged(binding: string): D1DatabaseLike {
  const send: Send = async (mode, statements) => {
    const response = await mf.dispatchFetch('http://bridge.test/', {
      method: 'POST',
      body: JSON.stringify({
        binding,
        mode,
        statements: statements.map(({ sql, params }) => ({
          sql,
          params: params.map(encodeParam),
        })),
      }),
    });
    const body = (await response.json()) as
      { ok: true; result: unknown[] } | { ok: false; message: string; cause: string | null };
    if (body.ok) return body.result;
    throw new Error(body.message, {
      cause: body.cause === null ? undefined : new Error(body.cause),
    });
  };
  return {
    prepare: (sql: string) => new BridgedStatement(sql, [], send),
    batch: (statements: BridgedStatement[]) => send('batch', statements),
  } as unknown as D1DatabaseLike;
}

async function openPair() {
  const db = bridged(allocateBinding());
  return {
    executor: createD1Executor(db),
    second: async () => createD1Executor(db),
    close: async () => {},
  };
}

describeAuthContract('d1', openPair);

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

function idsWith(prefix: string): Record<DefaultRoleKey, string> {
  return {
    organization_publisher: `${prefix}PUBLS0000000000000000`.slice(0, 26),
    organization_admin: `${prefix}ADMIN0000000000000000`.slice(0, 26),
    organization_auditor: `${prefix}ORGAUD000000000000000`.slice(0, 26),
    project_owner: `${prefix}OWNER00000000000000000`.slice(0, 26),
    project_developer: `${prefix}DEV0000000000000000000`.slice(0, 26),
    project_auditor: `${prefix}PRJAUD000000000000000`.slice(0, 26),
  };
}

describe('d1 concurrent role seeding', () => {
  it('11. two concurrent seeds for one organization leave five roles, the DEFAULT_ROLES sets and no orphans', async () => {
    const db = await database();
    const executor = createD1Executor(db);
    await migrate(executor, await loadSources(), { holder: 'auth-contract' });
    const { a } = await seedTwoOrganizations(executor);
    const now = '2026-10-15T12:00:00.000Z';

    await Promise.all([
      executor.batch(seedDefaultsStatements(a, { now, ids: idsWith('C1') })),
      executor.batch(seedDefaultsStatements(a, { now, ids: idsWith('C2') })),
    ]);

    const roles = await executor.all<{ key: string; permission: string | null }>({
      sql: `SELECT role.key AS key, role_permission.permission AS permission
            FROM role
            LEFT JOIN role_permission
              ON role_permission.role_id = role.id AND role_permission.org_id = role.org_id
            WHERE role.org_id = ?
            ORDER BY role.key, role_permission.permission`,
      params: [a.orgId],
    });
    const grouped = new Map<string, string[]>();
    for (const row of roles) {
      const permissions = grouped.get(row.key) ?? [];
      if (row.permission !== null) permissions.push(row.permission);
      grouped.set(row.key, permissions);
    }

    expect([...grouped.keys()].sort()).toEqual([...DEFAULT_ROLES.map((role) => role.key)].sort());
    for (const expected of DEFAULT_ROLES) {
      expect([...(grouped.get(expected.key) ?? [])].sort()).toEqual(
        [...expected.permissions].sort(),
      );
    }
    expect(
      await executor.all<{ n: number }>({
        sql: `SELECT count(*) AS n FROM role_permission
              WHERE role_id NOT IN (SELECT id FROM role)`,
        params: [],
      }),
    ).toEqual([{ n: 0 }]);
    expect(
      await executor.all<{ n: number }>({
        sql: 'SELECT count(*) AS n FROM role_permission',
        params: [],
      }),
    ).toEqual([{ n: DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0) }]);
  }, 60_000);
});

const FRESH_ORG = '01J00000000000000000000A0A';
const FRESH_USER_1 = '01J00000000000000000000A0B';
const FRESH_USER_2 = '01J00000000000000000000A0C';
const FRESH_CREDENTIAL = '01J00000000000000000000A0D';
const VALID_PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';
const VALID_SETUP_HASH = 'ab'.repeat(32);
const SETUP_EXPIRES = '2026-10-16T12:00:00.000Z';

function st(sql: string, ...params: ScalarStatement['params']): ScalarStatement {
  return { sql, params };
}

async function rejected(executor: SqlExecutor, statement: ScalarStatement): Promise<DbError> {
  try {
    await executor.batch([statement]);
  } catch (error) {
    const classified = classifySqliteError(error);
    expect(classified).toBeInstanceOf(DbError);
    return classified;
  }
  throw new Error(`expected the local login write to be rejected: ${statement.sql}`);
}

describe('d1 local login constraints on the fresh 0001 baseline', () => {
  it('rejects malformed hashes, unpaired setup, negative failures and duplicate setup or TOTP credentials', async () => {
    const db = await database();
    const executor = createD1Executor(db);
    const sources = (await loadSources()).filter(({ id }) => id === 'core:0001_init');
    expect(sources.map(({ id }) => id)).toEqual(['core:0001_init']);

    const result = await migrate(executor, sources, { holder: 'auth-contract' });
    expect(result.applied).toEqual(['core:0001_init']);
    await executor.batch([
      st('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', FRESH_ORG, 'acme', 'Acme'),
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        'u1@example.test',
      ),
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        FRESH_USER_2,
        FRESH_ORG,
        'u2@example.test',
      ),
      st(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
        FRESH_CREDENTIAL,
        FRESH_ORG,
      ),
    ]);

    const malformedPassword = await rejected(
      executor,
      st(
        'INSERT INTO local_login (user_id, org_id, password_hash) VALUES (?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        'not-a-pbkdf2-hash',
      ),
    );
    expect(malformedPassword.kind).toBe('check');

    const malformedSetup = await rejected(
      executor,
      st(
        'INSERT INTO local_login (user_id, org_id, setup_hash, setup_expires_at) VALUES (?, ?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        'AB'.repeat(32),
        SETUP_EXPIRES,
      ),
    );
    expect(malformedSetup.kind).toBe('check');

    const unpairedSetup = await rejected(
      executor,
      st(
        'INSERT INTO local_login (user_id, org_id, setup_hash) VALUES (?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        VALID_SETUP_HASH,
      ),
    );
    expect(unpairedSetup.kind).toBe('check');

    const negativeFailures = await rejected(
      executor,
      st(
        'INSERT INTO local_login (user_id, org_id, failed_count) VALUES (?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        -1,
      ),
    );
    expect(negativeFailures.kind).toBe('check');

    await executor.batch([
      st(
        'INSERT INTO local_login (user_id, org_id, setup_hash, setup_expires_at) VALUES (?, ?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        VALID_SETUP_HASH,
        SETUP_EXPIRES,
      ),
    ]);
    const duplicateSetup = await rejected(
      executor,
      st(
        'INSERT INTO local_login (user_id, org_id, setup_hash, setup_expires_at) VALUES (?, ?, ?, ?)',
        FRESH_USER_2,
        FRESH_ORG,
        VALID_SETUP_HASH,
        SETUP_EXPIRES,
      ),
    );
    expect(duplicateSetup.kind).toBe('unique');
    await executor.batch([st('DELETE FROM local_login')]);

    await executor.batch([
      st(
        'INSERT INTO local_login (user_id, org_id, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        FRESH_CREDENTIAL,
        SETUP_EXPIRES,
      ),
    ]);
    const duplicateTotp = await rejected(
      executor,
      st(
        'INSERT INTO local_login (user_id, org_id, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?)',
        FRESH_USER_2,
        FRESH_ORG,
        FRESH_CREDENTIAL,
        SETUP_EXPIRES,
      ),
    );
    expect(duplicateTotp.kind).toBe('unique');
    await executor.batch([st('DELETE FROM local_login')]);

    await executor.batch([
      st(
        'INSERT INTO local_login (user_id, org_id, password_hash, credential_rev) VALUES (?, ?, ?, ?)',
        FRESH_USER_1,
        FRESH_ORG,
        VALID_PASSWORD_HASH,
        1,
      ),
    ]);
    expect(
      await executor.all<{ n: number }>({
        sql: 'SELECT count(*) AS n FROM local_login',
        params: [],
      }),
    ).toEqual([{ n: 1 }]);
  }, 60_000);
});
