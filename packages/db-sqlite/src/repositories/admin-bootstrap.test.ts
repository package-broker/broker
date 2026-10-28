import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  SqlExecutor,
  StatementResult,
} from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  bootstrapAdmin,
  bootstrapAdminWithTopUp,
  bootstrapSsoAdmin,
  resetLocalLogin,
  type BootstrapAdminInput,
} from './admin-bootstrap.js';
import { createLocalLoginReader } from './local-login.js';
import { seedDefaultsStatements } from './role.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T13:00:00.000Z';
const SETUP_EXPIRES = '2026-10-16T12:00:00.000Z';
const LATER_EXPIRES = '2026-10-16T13:00:00.000Z';
const HASH_1 = 'a1'.repeat(32);
const HASH_2 = 'b2'.repeat(32);
const HASH_3 = 'c3'.repeat(32);
const PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';
const EMAIL = 'admin@example.test';
const OTHER_EMAIL = 'other@example.test';

const ROLE_IDS: Readonly<Record<DefaultRoleKey, string>> = {
  organization_admin: '01J0ROLEADMIN00000000000R1',
  organization_auditor: '01J0ROLEORGAUDITOR00000R2',
  project_owner: '01J0ROLEPROJOWNER00000000R3',
  project_developer: '01J0ROLEPROJDEV00000000R4',
  project_auditor: '01J0ROLEPROJAUDITOR000R5',
};

let database: MigratedDatabase;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;

function input(overrides: Partial<BootstrapAdminInput> = {}): BootstrapAdminInput {
  return {
    email: EMAIL,
    userId: '01J0USERADMIN00000000000U1',
    setupHash: HASH_1,
    setupExpiresAt: SETUP_EXPIRES,
    grantId: '01J0GRANTADMIN0000000000G1',
    roleIds: ROLE_IDS,
    opId: '01J0OP000000000000000000O1',
    now: NOW,
    ...overrides,
  };
}

const ROLE_IDS_B: Readonly<Record<DefaultRoleKey, string>> = {
  organization_admin: '01J0ROLEADMINB0000000000R1',
  organization_auditor: '01J0ROLEORGAUDITORB0000R2',
  project_owner: '01J0ROLEPROJOWNERB0000000R3',
  project_developer: '01J0ROLEPROJDEVB0000000R4',
  project_auditor: '01J0ROLEPROJAUDITORB00R5',
};

function resetInput(
  overrides: Partial<{
    roleIds: Readonly<Record<DefaultRoleKey, string>>;
    email: string;
    setupHash: string;
    setupExpiresAt: string;
    grantId: string;
    opId: string;
    now: string;
  }> = {},
) {
  return {
    email: EMAIL,
    setupHash: HASH_3,
    setupExpiresAt: LATER_EXPIRES,
    grantId: '01J0GRANTRESET0000000000G2',
    roleIds: ROLE_IDS,
    opId: '01J0OP000000000000000000O3',
    now: LATER,
    ...overrides,
  };
}

async function rows<R>(sql: string, ...params: (string | number | null)[]): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

async function run(sql: string, ...params: (string | number | null)[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

interface Recording {
  readonly executor: ScalarSqlExecutor;
  readonly statements: ScalarStatement[];
  readonly calls: { all: number; batch: number };
}

function recording(inner: ScalarSqlExecutor): Recording {
  const statements: ScalarStatement[] = [];
  const calls = { all: 0, batch: 0 };
  return {
    statements,
    calls,
    executor: {
      driver: inner.driver,
      all: async <R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]> => {
        calls.all += 1;
        statements.push(statement);
        return inner.all<R>(statement);
      },
      batch: async (list: readonly ScalarStatement[]): Promise<StatementResult[]> => {
        calls.batch += 1;
        statements.push(...list);
        return inner.batch(list);
      },
    },
  };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

async function grantsOf(
  ctx: OrgContext,
  email: string,
): Promise<{ id: string; key: string; scope: string }[]> {
  return rows(
    "SELECT g.id, r.key, g.scope FROM access_grant g JOIN role r ON r.id = g.role_id WHERE g.org_id = ? AND g.subject_type = 'email' AND g.subject_value = ? ORDER BY g.id",
    ctx.orgId,
    email,
  );
}

async function loginOf(ctx: OrgContext, email: string) {
  const found = await rows<{
    password_hash: string | null;
    setup_hash: string | null;
    setup_expires_at: string | null;
    last_op_id: string | null;
    credential_rev: number;
    totp_credential_id: string | null;
    totp_enabled_at: string | null;
    totp_last_step: number | null;
    failed_count: number;
    locked_until: string | null;
  }>(
    'SELECT l.password_hash, l.setup_hash, l.setup_expires_at, l.last_op_id, l.credential_rev, l.totp_credential_id, l.totp_enabled_at, l.totp_last_step, l.failed_count, l.locked_until FROM local_login l JOIN user_account u ON u.id = l.user_id WHERE u.org_id = ? AND u.email = ?',
    ctx.orgId,
    email,
  );
  return found[0] ?? null;
}

describe('bootstrapAdmin', () => {
  it('1: creates the roles, user, setup token and one admin grant in a fresh organization', async () => {
    expect(await bootstrapAdmin(executor, a, input())).toBe('created');

    const roles = await rows<{ key: string }>(
      'SELECT key FROM role WHERE org_id = ? ORDER BY key',
      a.orgId,
    );
    expect(roles.map((role) => role.key)).toEqual([
      'organization_admin',
      'organization_auditor',
      'project_auditor',
      'project_developer',
      'project_owner',
    ]);
    const users = await rows<{ id: string; status: string }>(
      'SELECT id, status FROM user_account WHERE org_id = ? AND email = ?',
      a.orgId,
      EMAIL,
    );
    expect(users).toEqual([{ id: input().userId, status: 'active' }]);
    expect(await loginOf(a, EMAIL)).toMatchObject({
      password_hash: null,
      setup_hash: HASH_1,
      setup_expires_at: SETUP_EXPIRES,
      last_op_id: input().opId,
    });
    expect(await grantsOf(a, EMAIL)).toEqual([
      { id: input().grantId, key: 'organization_admin', scope: 'organization' },
    ]);

    const snapshot = await createLocalLoginReader(executor).findByEmail(a, EMAIL);
    expect(snapshot?.adminEligible).toBe(true);
    expect(snapshot?.userActive).toBe(true);
  });

  it('1: normalizes the e-mail address', async () => {
    expect(await bootstrapAdmin(executor, a, input({ email: `  Admin@Example.TEST ` }))).toBe(
      'created',
    );
    expect(await loginOf(a, EMAIL)).not.toBeNull();
    expect(await grantsOf(a, EMAIL)).toHaveLength(1);
  });

  it('1: leaves the other organization untouched', async () => {
    await bootstrapAdmin(executor, a, input());
    for (const table of ['role', 'user_account', 'local_login', 'access_grant']) {
      const found = await rows<{ n: number }>(
        `SELECT count(*) AS n FROM ${table} WHERE org_id = ?`,
        b.orgId,
      );
      expect(found[0]?.n).toBe(0);
    }
  });

  it('2: promotes an existing organization auditor grant to admin and keeps one grant row', async () => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    await run(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      input().userId,
      a.orgId,
      EMAIL,
    );
    await run(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
      '01J0GRANTAUDITOR000000000G9',
      a.orgId,
      EMAIL,
      ROLE_IDS.organization_auditor,
    );

    expect(await bootstrapAdmin(executor, a, input())).toBe('created');

    expect(await grantsOf(a, EMAIL)).toEqual([
      { id: '01J0GRANTAUDITOR000000000G9', key: 'organization_admin', scope: 'organization' },
    ]);
  });

  it('2: uses the stored admin role when the roles were seeded under other ids', async () => {
    const earlier: Record<DefaultRoleKey, string> = {
      organization_admin: '01J0EARLIERADMIN000000000E1',
      organization_auditor: '01J0EARLIERORGAUD00000000E2',
      project_owner: '01J0EARLIERPROJOWN00000000E3',
      project_developer: '01J0EARLIERPROJDEV00000000E4',
      project_auditor: '01J0EARLIERPROJAUD00000000E5',
    };
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: earlier }));

    expect(await bootstrapAdmin(executor, a, input())).toBe('created');

    const roles = await rows<{ id: string }>('SELECT id FROM role WHERE org_id = ?', a.orgId);
    expect(roles).toHaveLength(5);
    const grants = await rows<{ role_id: string }>(
      'SELECT role_id FROM access_grant WHERE org_id = ?',
      a.orgId,
    );
    expect(grants).toEqual([{ role_id: earlier.organization_admin }]);
    expect((await createLocalLoginReader(executor).findByEmail(a, EMAIL))?.adminEligible).toBe(
      true,
    );
  });

  it('2: ignores project-scope grants of the same e-mail address', async () => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    await run(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('01J0PROJECT0000000000000P1', ?, 'p', 'P')",
      a.orgId,
    );
    await run(
      "INSERT INTO user_account (id, org_id, email) VALUES ('01J0USERADMIN00000000000U1', ?, ?)",
      a.orgId,
      EMAIL,
    );
    await run(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES ('01J0GRANTPROJECT00000000G8', ?, 'email', ?, 'project', '01J0PROJECT0000000000000P1', ?)",
      a.orgId,
      EMAIL,
      ROLE_IDS.project_owner,
    );

    await bootstrapAdmin(executor, a, input());

    const grants = await rows<{ id: string; scope: string; key: string }>(
      'SELECT g.id, g.scope, r.key FROM access_grant g JOIN role r ON r.id = g.role_id WHERE g.org_id = ? ORDER BY g.scope',
      a.orgId,
    );
    expect(grants).toEqual([
      { id: input().grantId, scope: 'organization', key: 'organization_admin' },
      { id: '01J0GRANTPROJECT00000000G8', scope: 'project', key: 'project_owner' },
    ]);
  });

  it('2: reactivates a suspended user', async () => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    await run(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'suspended')",
      input().userId,
      a.orgId,
      EMAIL,
    );

    await bootstrapAdmin(executor, a, input({ userId: '01J0USERIGNORED000000000U9', now: LATER }));

    const users = await rows<{ id: string; status: string; updated_at: string }>(
      'SELECT id, status, updated_at FROM user_account WHERE org_id = ?',
      a.orgId,
    );
    expect(users).toEqual([{ id: input().userId, status: 'active', updated_at: LATER }]);
  });

  it('3: refreshes the setup token until the password is set, then reports already_set_up', async () => {
    expect(await bootstrapAdmin(executor, a, input())).toBe('created');
    const refreshed = input({
      setupHash: HASH_2,
      setupExpiresAt: LATER_EXPIRES,
      opId: '01J0OP000000000000000000O2',
      grantId: '01J0GRANTADMIN0000000000G2',
    });
    expect(await bootstrapAdmin(executor, a, refreshed)).toBe('refreshed');
    expect(await loginOf(a, EMAIL)).toMatchObject({
      setup_hash: HASH_2,
      setup_expires_at: LATER_EXPIRES,
      last_op_id: refreshed.opId,
    });
    expect(await grantsOf(a, EMAIL)).toHaveLength(1);

    await run(
      'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      PASSWORD_HASH,
    );
    const before = await loginOf(a, EMAIL);
    const again = input({
      setupHash: HASH_3,
      setupExpiresAt: LATER_EXPIRES,
      opId: '01J0OP000000000000000000O4',
    });
    expect(await bootstrapAdmin(executor, a, again)).toBe('already_set_up');
    expect(await loginOf(a, EMAIL)).toEqual(before);
    expect((await loginOf(a, EMAIL))?.password_hash).toBe(PASSWORD_HASH);
  });

  it('3: classifies by the stored row, not by time, when calls share the same now', async () => {
    const first = input();
    const second = input({
      setupHash: HASH_2,
      opId: '01J0OP000000000000000000O2',
      grantId: '01J0GRANTADMIN0000000000G2',
    });
    expect(first.now).toBe(second.now);
    expect(await bootstrapAdmin(executor, a, first)).toBe('created');
    expect(await bootstrapAdmin(executor, a, second)).toBe('refreshed');
    expect(
      await bootstrapAdmin(
        executor,
        a,
        input({ opId: '01J0OP000000000000000000O5', setupHash: HASH_3 }),
      ),
    ).toBe('refreshed');
    expect((await loginOf(a, EMAIL))?.setup_hash).toBe(HASH_3);
  });

  it('3: a user without a local login gets one, even though the user already existed', async () => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    await run(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      input().userId,
      a.orgId,
      EMAIL,
    );
    expect(await bootstrapAdmin(executor, a, input())).toBe('created');
  });

  it('3: the same e-mail address in another organization is independent', async () => {
    expect(await bootstrapAdmin(executor, a, input())).toBe('created');
    const inB = input({
      userId: '01J0USERADMIN00000000000U2',
      grantId: '01J0GRANTADMIN0000000000G3',
      setupHash: HASH_2,
      roleIds: ROLE_IDS_B,
    });
    expect(await bootstrapAdmin(executor, b, inB)).toBe('created');
    expect(await grantsOf(a, EMAIL)).toHaveLength(1);
    expect(await grantsOf(b, EMAIL)).toHaveLength(1);
  });

  it('3: a refresh clears the failure counter and the lock', async () => {
    await bootstrapAdmin(executor, a, input());
    await run(
      'UPDATE local_login SET failed_count = 4, locked_until = ? WHERE user_id = ?',
      SETUP_EXPIRES,
      input().userId,
    );
    const refreshed = input({
      setupHash: HASH_2,
      opId: '01J0OP000000000000000000O2',
      grantId: '01J0GRANTADMIN0000000000G2',
    });
    expect(await bootstrapAdmin(executor, a, refreshed)).toBe('refreshed');
    expect(await loginOf(a, EMAIL)).toMatchObject({ failed_count: 0, locked_until: null });
  });

  it('1: already_set_up writes nothing: a suspended, set-up admin stays suspended and ungranted', async () => {
    await bootstrapAdmin(executor, a, input());
    await run(
      'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      PASSWORD_HASH,
    );
    await run('DELETE FROM access_grant WHERE org_id = ?', a.orgId);
    await run("UPDATE user_account SET status = 'suspended' WHERE id = ?", input().userId);
    const dump = () =>
      rows(
        "SELECT 'user' AS t, id AS k, status || updated_at AS v FROM user_account UNION ALL SELECT 'login', user_id, ifnull(setup_hash, '') || ifnull(last_op_id, '') || updated_at || password_hash FROM local_login UNION ALL SELECT 'grant', id, role_id FROM access_grant UNION ALL SELECT 'role', id, updated_at FROM role ORDER BY 1, 2",
      );
    const before = await dump();

    const again = input({
      userId: '01J0USERIGNORED000000000U9',
      setupHash: HASH_3,
      opId: '01J0OP000000000000000000O4',
      grantId: '01J0GRANTADMIN0000000000G9',
      now: LATER,
      setupExpiresAt: LATER_EXPIRES,
    });
    expect(await bootstrapAdmin(executor, a, again)).toBe('already_set_up');

    expect(await dump()).toEqual(before);
    expect(await rows('SELECT status FROM user_account')).toEqual([{ status: 'suspended' }]);
    expect(await grantsOf(a, EMAIL)).toEqual([]);
  });

  it('5: is one executor call with scalar parameters only', async () => {
    const counted = countCalls(executor);
    await bootstrapAdmin(counted.executor, a, input());
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });

    const recorded = recording(executor);
    await bootstrapAdmin(recorded.executor, a, input({ opId: '01J0OP000000000000000000O2' }));
    expect(recorded.calls).toEqual({ all: 0, batch: 1 });
    expect(recorded.statements.length).toBeGreaterThan(10);
    for (const statement of recorded.statements) {
      for (const param of statement.params) {
        const scalar =
          param === null ||
          typeof param === 'string' ||
          (typeof param === 'number' && Number.isSafeInteger(param));
        expect(scalar, statement.sql).toBe(true);
      }
    }
  });

  it('5: reads the local login first and returns the upsert of the last statement', async () => {
    const recorded = recording(executor);
    await bootstrapAdmin(recorded.executor, a, input());
    const first = recorded.statements[0]?.sql ?? '';
    expect(first).toMatch(/^select exists \(select 1 as "one" from "local_login"/);
    expect(first).toContain('as "existed"');
    const last = recorded.statements.at(-1)?.sql ?? '';
    expect(last).toMatch(/^insert into "local_login"/);
    expect(last).toMatch(/on conflict \("user_id"\) do update set/);
    expect(last).toMatch(/where "local_login"\."password_hash" is null returning "user_id"$/);
  });

  it('5: rejects invalid input with a TypeError and no executor call', async () => {
    const counted = countCalls(executor);
    const bad: Partial<BootstrapAdminInput>[] = [
      { email: 'not-an-email' },
      { email: 'a@localhost' },
      { email: 'josé@example.test' },
      { email: '' },
      { setupHash: 'ABC' },
      { setupHash: 'A1'.repeat(32) },
      { setupExpiresAt: 'tomorrow' },
      { setupExpiresAt: NOW },
      { setupExpiresAt: '2026-10-15T11:59:59.999Z' },
      { now: '2026-10-15 12:00:00' },
      { userId: 'x'.repeat(65) },
      { userId: 'has space' },
      { opId: 'caf\u00e9' },
      { grantId: 'a\nb' },
      { opId: '' },
      { userId: '' },
      { grantId: '' },
      { roleIds: { ...ROLE_IDS, organization_admin: '' } },
    ];
    for (const overrides of bad) {
      await expect(
        bootstrapAdmin(counted.executor, a, input(overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('bootstrapAdmin organization_admin top-up', () => {
  const TOPPED = ['org:projects:archive', 'project:service-principals:write'];

  async function adminRole(ctx: OrgContext) {
    const found = await rows<{ id: string; revision: number; updated_at: string }>(
      "SELECT id, revision, updated_at FROM role WHERE org_id = ? AND key = 'organization_admin'",
      ctx.orgId,
    );
    return found[0] ?? null;
  }

  async function epochOf(ctx: OrgContext): Promise<string | null> {
    const found = await rows<{ version: string }>(
      'SELECT version FROM cache_epoch WHERE org_id = ?',
      ctx.orgId,
    );
    return found[0]?.version ?? null;
  }

  async function adminPermissions(ctx: OrgContext): Promise<string[]> {
    const found = await rows<{ permission: string }>(
      "SELECT p.permission FROM role_permission p JOIN role r ON r.id = p.role_id WHERE r.org_id = ? AND r.key = 'organization_admin' ORDER BY p.permission",
      ctx.orgId,
    );
    return found.map((row) => row.permission);
  }

  async function otherRoles(ctx: OrgContext) {
    return {
      roles: await rows(
        "SELECT * FROM role WHERE org_id = ? AND key <> 'organization_admin' ORDER BY id",
        ctx.orgId,
      ),
      permissions: await rows(
        "SELECT p.* FROM role_permission p JOIN role r ON r.id = p.role_id WHERE p.org_id = ? AND r.key <> 'organization_admin' ORDER BY p.role_id, p.permission",
        ctx.orgId,
      ),
    };
  }

  async function dropTwo(ctx: OrgContext): Promise<void> {
    await run(
      "DELETE FROM role_permission WHERE org_id = ? AND permission IN (?, ?) AND role_id IN (SELECT id FROM role WHERE key = 'organization_admin')",
      ctx.orgId,
      TOPPED[0] ?? '',
      TOPPED[1] ?? '',
    );
  }

  const second = () =>
    input({
      setupHash: HASH_2,
      setupExpiresAt: LATER_EXPIRES,
      opId: '01J0OP000000000000000000O7',
      grantId: '01J0GRANTADMIN0000000000G7',
      now: LATER,
    });

  it('a fresh organization reports no top-up and keeps its cache epoch', async () => {
    const epoch = await epochOf(a);
    expect(await bootstrapAdminWithTopUp(executor, a, input())).toEqual({
      result: 'created',
      toppedUp: 0,
    });
    expect((await adminRole(a))?.revision).toBe(1);
    expect(await epochOf(a)).toBe(epoch);
  });

  it('two missing permissions: toppedUp 2, revision +1, updated_at the batch time, cache epoch replaced', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    const complete = await adminPermissions(a);
    await dropTwo(a);
    const role = await adminRole(a);
    const epoch = await epochOf(a);
    const epochB = await epochOf(b);
    const others = await otherRoles(a);
    expect(others.roles).toHaveLength(4);
    expect(others.permissions.length).toBeGreaterThan(0);

    expect(await bootstrapAdminWithTopUp(executor, a, second())).toEqual({
      result: 'refreshed',
      toppedUp: 2,
    });

    expect(await adminRole(a)).toEqual({
      id: role?.id,
      revision: (role?.revision ?? 0) + 1,
      updated_at: LATER,
    });
    expect(await epochOf(a)).not.toBe(epoch);
    expect(await epochOf(a)).toMatch(/^[0-9A-F]{32}$/);
    expect(await epochOf(b)).toBe(epochB);
    expect(await adminPermissions(a)).toEqual(complete);
    expect(await otherRoles(a)).toEqual(others);
  });

  it('a replay after a top-up gives toppedUp 0 and leaves the revision and the epoch alone', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    await dropTwo(a);
    expect((await bootstrapAdminWithTopUp(executor, a, second())).toppedUp).toBe(2);
    const role = await adminRole(a);
    const epoch = await epochOf(a);

    expect(
      await bootstrapAdminWithTopUp(
        executor,
        a,
        input({
          setupHash: HASH_3,
          setupExpiresAt: LATER_EXPIRES,
          opId: '01J0OP000000000000000000O8',
          grantId: '01J0GRANTADMIN0000000000G8',
          now: LATER,
        }),
      ),
    ).toEqual({ result: 'refreshed', toppedUp: 0 });
    expect(await adminRole(a)).toEqual(role);
    expect(await epochOf(a)).toBe(epoch);
  });

  it('a set-up admin still gets the top-up and reports already_set_up with the count', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    await run(
      'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      PASSWORD_HASH,
    );
    await dropTwo(a);
    const role = await adminRole(a);
    const epoch = await epochOf(a);

    expect(await bootstrapAdminWithTopUp(executor, a, second())).toEqual({
      result: 'already_set_up',
      toppedUp: 2,
    });
    expect((await adminRole(a))?.revision).toBe((role?.revision ?? 0) + 1);
    expect(await epochOf(a)).not.toBe(epoch);
  });

  it('a complete organization: toppedUp 0, revision, updated_at and cache epoch unchanged', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    const role = await adminRole(a);
    const epoch = await epochOf(a);

    expect(await bootstrapAdminWithTopUp(executor, a, second())).toEqual({
      result: 'refreshed',
      toppedUp: 0,
    });
    expect(await adminRole(a)).toEqual(role);
    expect(await epochOf(a)).toBe(epoch);
  });

  it('a batch failure after the insert rolls back the permissions, the revision and the epoch bump', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    await dropTwo(a);
    const role = await adminRole(a);
    const epoch = await epochOf(a);
    const permissions = await adminPermissions(a);

    const faulty: ScalarSqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: (list) =>
        executor.batch([
          ...list,
          { sql: 'INSERT INTO access_mutation_guard (key) VALUES (?), (?)', params: ['x', 'x'] },
        ]),
    };
    await expect(bootstrapAdminWithTopUp(faulty, a, second())).rejects.toThrow(
      /UNIQUE|constraint/i,
    );

    expect(await adminRole(a)).toEqual(role);
    expect(await epochOf(a)).toBe(epoch);
    expect(await adminPermissions(a)).toEqual(permissions);
  });

  it('a top-up without a cache_epoch row fails the whole batch', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    await dropTwo(a);
    await run('DELETE FROM cache_epoch WHERE org_id = ?', a.orgId);
    const role = await adminRole(a);
    const permissions = await adminPermissions(a);

    await expect(bootstrapAdminWithTopUp(executor, a, second())).rejects.toThrow(
      /UNIQUE|constraint/i,
    );

    expect(await adminRole(a)).toEqual(role);
    expect(await adminPermissions(a)).toEqual(permissions);
  });

  it('an unprotected role keyed organization_admin is never topped up', async () => {
    await bootstrapAdminWithTopUp(executor, a, input());
    await run(
      "UPDATE role SET protects_last_holder = 0 WHERE org_id = ? AND key = 'organization_admin'",
      a.orgId,
    );
    await dropTwo(a);
    const role = await adminRole(a);
    const epoch = await epochOf(a);

    expect((await bootstrapAdminWithTopUp(executor, a, second())).toppedUp).toBe(0);
    expect(await adminRole(a)).toEqual(role);
    expect(await epochOf(a)).toBe(epoch);
    const held = await adminPermissions(a);
    for (const permission of TOPPED) expect(held).not.toContain(permission);
  });
});

describe('resetLocalLogin', () => {
  const CREDENTIAL = '01J0CREDENTIAL000000000000A';
  const SESSION_ACTIVE = '01J0SESSIONACTIVE0000000S1';
  const SESSION_OLD = '01J0SESSIONREVOKED0000000S2';
  const SESSION_OTHER = '01J0SESSIONOTHERUSER00000S3';

  async function completedAdmin(): Promise<void> {
    await bootstrapAdmin(executor, a, input());
    await bootstrapAdmin(
      executor,
      a,
      input({
        email: OTHER_EMAIL,
        userId: '01J0USERADMIN00000000000U2',
        setupHash: HASH_2,
        grantId: '01J0GRANTOTHER0000000000G4',
        opId: '01J0OP000000000000000000O6',
      }),
    );
    await run(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      CREDENTIAL,
      a.orgId,
    );
    await run(
      'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL, totp_credential_id = ?, totp_enabled_at = ?, totp_last_step = 57, credential_rev = 4, failed_count = 3, locked_until = ? WHERE user_id = ?',
      PASSWORD_HASH,
      CREDENTIAL,
      NOW,
      SETUP_EXPIRES,
      input().userId,
    );
    const session = (id: string, user: string, revokedAt: string | null, secret: string) =>
      run(
        'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        a.orgId,
        user,
        secret.repeat(64).slice(0, 64),
        'f'.repeat(64),
        SETUP_EXPIRES,
        revokedAt,
      );
    await session(SESSION_ACTIVE, input().userId, null, '1');
    await session(SESSION_OLD, input().userId, '2026-10-14T00:00:00.000Z', '2');
    await session(SESSION_OTHER, '01J0USERADMIN00000000000U2', null, '3');
  }

  it('4: restores a suspended admin whose grant was removed and clears the credentials', async () => {
    await completedAdmin();
    await run('DELETE FROM access_grant WHERE org_id = ? AND subject_value = ?', a.orgId, EMAIL);
    await run("UPDATE user_account SET status = 'suspended' WHERE id = ?", input().userId);

    expect(await resetLocalLogin(executor, a, resetInput())).toBe('reset');

    const users = await rows<{ status: string; updated_at: string }>(
      'SELECT status, updated_at FROM user_account WHERE id = ?',
      input().userId,
    );
    expect(users).toEqual([{ status: 'active', updated_at: LATER }]);
    expect(await grantsOf(a, EMAIL)).toEqual([
      { id: resetInput().grantId, key: 'organization_admin', scope: 'organization' },
    ]);
    expect(await loginOf(a, EMAIL)).toEqual({
      password_hash: null,
      setup_hash: HASH_3,
      setup_expires_at: LATER_EXPIRES,
      last_op_id: resetInput().opId,
      credential_rev: 5,
      totp_credential_id: null,
      totp_enabled_at: null,
      totp_last_step: null,
      failed_count: 0,
      locked_until: null,
    });
    expect(await rows('SELECT id FROM credential WHERE id = ?', CREDENTIAL)).toEqual([]);
    const sessions = await rows<{ id: string; revoked_at: string | null }>(
      'SELECT id, revoked_at FROM session ORDER BY id',
    );
    expect(sessions).toEqual([
      { id: SESSION_ACTIVE, revoked_at: LATER },
      { id: SESSION_OTHER, revoked_at: null },
      { id: SESSION_OLD, revoked_at: '2026-10-14T00:00:00.000Z' },
    ]);
    const snapshot = await createLocalLoginReader(executor).findByEmail(a, EMAIL);
    expect(snapshot?.adminEligible).toBe(true);
    expect(snapshot?.totpState).toBe('none');
  });

  it('4: promotes a downgraded grant and leaves the other user untouched', async () => {
    await completedAdmin();
    await run(
      'UPDATE access_grant SET role_id = ? WHERE org_id = ? AND subject_value = ?',
      ROLE_IDS.organization_auditor,
      a.orgId,
      EMAIL,
    );
    const otherBefore = await loginOf(a, OTHER_EMAIL);

    expect(await resetLocalLogin(executor, a, resetInput())).toBe('reset');

    expect(await grantsOf(a, EMAIL)).toEqual([
      { id: input().grantId, key: 'organization_admin', scope: 'organization' },
    ]);
    expect(await loginOf(a, OTHER_EMAIL)).toEqual(otherBefore);
  });

  it('4: works when the user has no TOTP credential yet', async () => {
    await bootstrapAdmin(executor, a, input());
    expect(await resetLocalLogin(executor, a, resetInput())).toBe('reset');
    expect(await loginOf(a, EMAIL)).toMatchObject({ setup_hash: HASH_3, credential_rev: 1 });
  });

  it('4: an unknown e-mail address is not_found and changes nothing', async () => {
    await completedAdmin();
    const snapshot = await rows(
      'SELECT (SELECT count(*) FROM user_account) AS users, (SELECT count(*) FROM access_grant) AS grants, (SELECT count(*) FROM session WHERE revoked_at IS NOT NULL) AS revoked, (SELECT count(*) FROM credential) AS credentials',
    );
    expect(await resetLocalLogin(executor, a, resetInput({ email: 'nobody@example.test' }))).toBe(
      'not_found',
    );
    expect(
      await rows(
        'SELECT (SELECT count(*) FROM user_account) AS users, (SELECT count(*) FROM access_grant) AS grants, (SELECT count(*) FROM session WHERE revoked_at IS NOT NULL) AS revoked, (SELECT count(*) FROM credential) AS credentials',
      ),
    ).toEqual(snapshot);
  });

  it('4: creates a local login for an existing user that has none and restores the grant', async () => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    await run(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'suspended')",
      input().userId,
      a.orgId,
      EMAIL,
    );
    await run(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      SESSION_ACTIVE,
      a.orgId,
      input().userId,
      '1'.repeat(64),
      '2'.repeat(64),
      SETUP_EXPIRES,
    );

    expect(await resetLocalLogin(executor, a, resetInput())).toBe('reset');

    expect(await rows('SELECT status FROM user_account WHERE id = ?', input().userId)).toEqual([
      { status: 'active' },
    ]);
    expect(await loginOf(a, EMAIL)).toMatchObject({
      password_hash: null,
      setup_hash: HASH_3,
      setup_expires_at: LATER_EXPIRES,
      last_op_id: resetInput().opId,
      credential_rev: 0,
    });
    expect(await grantsOf(a, EMAIL)).toEqual([
      { id: resetInput().grantId, key: 'organization_admin', scope: 'organization' },
    ]);
    expect(await rows('SELECT revoked_at FROM session')).toEqual([{ revoked_at: LATER }]);
    expect((await createLocalLoginReader(executor).findByEmail(a, EMAIL))?.adminEligible).toBe(
      true,
    );
  });

  it('4: an organization without the admin role changes nothing, even with a matching op marker', async () => {
    const stale = resetInput({ roleIds: ROLE_IDS_B });
    await run(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'suspended')",
      input().userId,
      b.orgId,
      EMAIL,
    );
    await run(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      CREDENTIAL,
      b.orgId,
    );
    await run(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, credential_rev, last_op_id) VALUES (?, ?, ?, ?, ?, 3, ?)',
      input().userId,
      b.orgId,
      PASSWORD_HASH,
      CREDENTIAL,
      NOW,
      stale.opId,
    );
    await run(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      SESSION_ACTIVE,
      b.orgId,
      input().userId,
      '1'.repeat(64),
      '2'.repeat(64),
      SETUP_EXPIRES,
    );
    const dump = () =>
      rows(
        "SELECT (SELECT count(*) FROM role) AS roles, (SELECT count(*) FROM access_grant) AS grants, (SELECT status || updated_at FROM user_account) AS user, (SELECT ifnull(revoked_at, 'none') FROM session) AS session, (SELECT count(*) FROM credential) AS credentials, (SELECT password_hash || credential_rev || ifnull(setup_hash, '') || last_op_id || updated_at || totp_credential_id || totp_enabled_at FROM local_login) AS login",
      );
    const before = await dump();

    expect(await resetLocalLogin(executor, b, stale)).toBe('admin_role_missing');

    expect(await dump()).toEqual(before);
    expect(before[0]).toMatchObject({ credentials: 1, roles: 0 });
  });

  it('4: resetting the same e-mail address in organization B leaves organization A unchanged', async () => {
    await completedAdmin();
    await bootstrapAdmin(
      executor,
      b,
      input({
        userId: '01J0USERADMIN00000000000U7',
        grantId: '01J0GRANTADMIN0000000000G7',
        setupHash: 'd4'.repeat(32),
        roleIds: ROLE_IDS_B,
        opId: '01J0OP000000000000000000O8',
      }),
    );
    const dumpA = () =>
      rows(
        "SELECT 'user' AS t, id AS k, status || updated_at AS v FROM user_account WHERE org_id = ? UNION ALL SELECT 'login', user_id, ifnull(password_hash, '') || credential_rev || ifnull(totp_credential_id, '') || ifnull(setup_hash, '') FROM local_login WHERE org_id = ? UNION ALL SELECT 'grant', id, role_id || updated_at FROM access_grant WHERE org_id = ? UNION ALL SELECT 'credential', id, org_id FROM credential WHERE org_id = ? UNION ALL SELECT 'session', id, ifnull(revoked_at, '') FROM session WHERE org_id = ? ORDER BY 1, 2",
        a.orgId,
        a.orgId,
        a.orgId,
        a.orgId,
        a.orgId,
      );
    const before = await dumpA();

    expect(await resetLocalLogin(executor, b, resetInput({ roleIds: ROLE_IDS_B }))).toBe('reset');

    expect(await dumpA()).toEqual(before);
    expect(await rows('SELECT credential_rev FROM local_login WHERE org_id = ?', b.orgId)).toEqual([
      { credential_rev: 1 },
    ]);
  });

  it('5: is one executor call with scalar parameters only', async () => {
    await completedAdmin();
    const counted = countCalls(executor);
    await resetLocalLogin(counted.executor, a, resetInput());
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });

    const recorded = recording(executor);
    await resetLocalLogin(recorded.executor, a, resetInput({ opId: '01J0OP000000000000000000O7' }));
    expect(recorded.calls).toEqual({ all: 0, batch: 1 });
    for (const statement of recorded.statements) {
      for (const param of statement.params) {
        const scalar =
          param === null ||
          typeof param === 'string' ||
          (typeof param === 'number' && Number.isSafeInteger(param));
        expect(scalar, statement.sql).toBe(true);
      }
    }
  });

  it('5: rejects invalid input with a TypeError and no executor call', async () => {
    const counted = countCalls(executor);
    const bad = [
      { email: 'not-an-email' },
      { email: 'a@localhost' },
      { email: 'jos\u00e9@example.test' },
      { setupHash: 'xyz' },
      { setupExpiresAt: '2026-10-16' },
      { setupExpiresAt: LATER },
      { roleIds: { ...ROLE_IDS, organization_admin: '' } },
      { opId: 'x'.repeat(65) },
      { now: 'now' },
      { opId: '' },
      { grantId: '' },
    ];
    for (const overrides of bad) {
      await expect(
        resetLocalLogin(counted.executor, a, resetInput(overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('two connections', () => {
  let directory: string;
  let shared: MigratedDatabase;
  let first: SqlExecutor;
  let second: SqlExecutor;
  let org: OrgContext;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'admin-bootstrap-'));
    shared = await openMigratedDatabase({
      file: join(directory, 'db.sqlite'),
      twoOrganizations: true,
    });
    if (shared.orgs === null) throw new Error('two organizations were not seeded');
    org = shared.orgs.a;
    first = shared.executor;
    second = await shared.second();
  });

  afterEach(async () => {
    await shared.close();
    await rm(directory, { recursive: true, force: true });
  });

  const count = async (table: string): Promise<number> => {
    const found = await first.all<{ n: number }>({
      sql: `SELECT count(*) AS n FROM ${table}`,
      params: [],
    });
    return found[0]?.n ?? -1;
  };

  const other = (n: number, email: string, hash: string): BootstrapAdminInput =>
    input({
      email,
      userId: `01J0USERCONCURRENT0000000U${n}`,
      grantId: `01J0GRANTCONCURRENT000000G${n}`,
      opId: `01J0OPCONCURRENT00000000000O${n}`,
      setupHash: hash,
      roleIds: {
        organization_admin: `01J0ROLEADMIN0000000000${n}R1`,
        organization_auditor: `01J0ROLEORGAUDITOR00000${n}R2`,
        project_owner: `01J0ROLEPROJOWNER0000000${n}R3`,
        project_developer: `01J0ROLEPROJDEV0000000${n}R4`,
        project_auditor: `01J0ROLEPROJAUDITOR000${n}R5`,
      },
    });

  it('4: the same e-mail address twice gives created and refreshed with one user, login and grant', async () => {
    const one = other(1, EMAIL, HASH_1);
    const two = other(2, EMAIL, HASH_2);
    const outcomes = await Promise.all([
      bootstrapAdmin(first, org, one),
      bootstrapAdmin(second, org, two),
    ]);

    expect([...outcomes].sort()).toEqual(['created', 'refreshed']);
    expect(await count('user_account')).toBe(1);
    expect(await count('local_login')).toBe(1);
    expect(await count('access_grant')).toBe(1);
    expect(await count('role')).toBe(5);
    const refreshedHash = outcomes[0] === 'refreshed' ? HASH_1 : HASH_2;
    const stored = await first.all<{ setup_hash: string }>({
      sql: 'SELECT setup_hash FROM local_login',
      params: [],
    });
    expect(stored).toEqual([{ setup_hash: refreshedHash }]);
  });

  it('4: different e-mail addresses give two admins; no admin-exists gate', async () => {
    const outcomes = await Promise.all([
      bootstrapAdmin(first, org, other(1, EMAIL, HASH_1)),
      bootstrapAdmin(second, org, other(2, OTHER_EMAIL, HASH_2)),
    ]);

    expect(outcomes).toEqual(['created', 'created']);
    expect(await count('user_account')).toBe(2);
    expect(await count('local_login')).toBe(2);
    expect(await count('access_grant')).toBe(2);
    const reader = createLocalLoginReader(first);
    expect((await reader.findByEmail(org, EMAIL))?.adminEligible).toBe(true);
    expect((await reader.findByEmail(org, OTHER_EMAIL))?.adminEligible).toBe(true);
  });
});

describe('import and package default grants', () => {
  const permissions = ['org:packages:manage', 'org:import:write', 'org:import:approve'];

  it('seeds all three permissions to Organization Admin', async () => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    const granted = await rows<{ permission: string }>(
      'SELECT permission FROM role_permission WHERE org_id = ? AND role_id = ?',
      a.orgId,
      ROLE_IDS.organization_admin,
    );
    expect(granted.map(({ permission }) => permission)).toEqual(
      expect.arrayContaining(permissions),
    );
  });

  it.each([
    'organization_auditor',
    'project_owner',
    'project_developer',
    'project_auditor',
  ] as const)('does not seed the new permissions to %s', async (key) => {
    await executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    const granted = await rows<{ permission: string }>(
      'SELECT permission FROM role_permission WHERE org_id = ? AND role_id = ?',
      a.orgId,
      ROLE_IDS[key],
    );
    for (const permission of permissions) {
      expect(granted.map((row) => row.permission)).not.toContain(permission);
    }
  });
});

describe('bootstrapSsoAdmin', () => {
  const emailInput = () => ({
    subject: { type: 'email' as const, value: '  Admin@Example.TEST ' },
    userId: input().userId,
    grantId: input().grantId,
    roleIds: ROLE_IDS,
    now: NOW,
  });
  const groupInput = () => ({
    subject: { type: 'group' as const, provider: 'dex', value: 'DevOps@example.test' },
    grantId: input().grantId,
    roleIds: ROLE_IDS,
    now: NOW,
  });
  const tables = [
    'user_account',
    'local_login',
    'identity',
    'session',
    'credential',
    'access_grant',
    'role',
    'role_permission',
    'cache_epoch',
  ] as const;
  async function snapshot(ctx: OrgContext) {
    return Promise.all(
      tables.map((table) =>
        rows(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1, 2`, ctx.orgId),
      ),
    );
  }

  for (const [variant, makeInput] of [
    ['email', emailInput],
    ['group', groupInput],
  ] as const) {
    it(`${variant}: seeds default permissions and exactly one admin grant without local state; reruns preserve both organizations`, async () => {
      await bootstrapAdmin(
        executor,
        b,
        input({
          userId: 'foreign-user',
          grantId: 'foreign-grant',
          roleIds: ROLE_IDS_B,
        }),
      );
      if (variant === 'group') {
        await bootstrapSsoAdmin(executor, b, {
          ...groupInput(),
          grantId: 'foreign-group',
          roleIds: ROLE_IDS_B,
        });
      }
      const foreignBefore = await snapshot(b);
      const record = recording(executor);
      expect(await bootstrapSsoAdmin(record.executor, a, makeInput())).toEqual({
        result: 'created',
        toppedUp: 0,
      });
      expect(record.calls).toEqual({ all: 0, batch: 1 });
      expect(
        await rows('SELECT email, status FROM user_account WHERE org_id = ?', a.orgId),
      ).toEqual(variant === 'email' ? [{ email: EMAIL, status: 'active' }] : []);
      expect(
        await rows(
          'SELECT subject_type, subject_value, subject_provider, scope, role_id FROM access_grant WHERE org_id = ?',
          a.orgId,
        ),
      ).toEqual([
        {
          subject_type: variant,
          subject_value: variant === 'email' ? EMAIL : 'DevOps@example.test',
          subject_provider: variant === 'email' ? null : 'dex',
          scope: 'organization',
          role_id: ROLE_IDS.organization_admin,
        },
      ]);
      for (const table of ['local_login', 'session', 'credential', 'identity']) {
        expect(await rows(`SELECT * FROM ${table} WHERE org_id = ?`, a.orgId)).toEqual([]);
      }
      for (const role of DEFAULT_ROLES) {
        expect(
          await rows(
            'SELECT permission FROM role_permission WHERE org_id = ? AND role_id = ? ORDER BY permission',
            a.orgId,
            ROLE_IDS[role.key],
          ),
        ).toEqual([...role.permissions].sort().map((permission) => ({ permission })));
      }
      const ownBefore = await snapshot(a);
      expect(
        await bootstrapSsoAdmin(executor, a, {
          ...makeInput(),
          now: LATER,
          grantId: 'unused-grant',
          roleIds: ROLE_IDS_B,
        }),
      ).toEqual({ result: 'already_admin', toppedUp: 0 });
      expect(await snapshot(a)).toEqual(ownBefore);
      expect(await snapshot(b)).toEqual(foreignBefore);
    });

    it(`${variant}: reports promotion and advances the existing grant revision`, async () => {
      await bootstrapSsoAdmin(executor, a, makeInput());
      await run(
        'UPDATE access_grant SET role_id = ?, last_op_id = ? WHERE org_id = ?',
        ROLE_IDS.organization_auditor,
        'previous-operation',
        a.orgId,
      );
      const accounts = await rows('SELECT * FROM user_account WHERE org_id = ?', a.orgId);
      expect(await bootstrapSsoAdmin(executor, a, { ...makeInput(), now: LATER })).toEqual({
        result: 'promoted',
        toppedUp: 0,
      });
      expect(
        await rows(
          'SELECT id, role_id, revision, last_op_id FROM access_grant WHERE org_id = ?',
          a.orgId,
        ),
      ).toEqual([
        {
          id: input().grantId,
          role_id: ROLE_IDS.organization_admin,
          revision: 2,
          last_op_id: expect.any(String),
        },
      ]);
      expect(
        await rows(
          'SELECT last_op_id FROM access_grant WHERE org_id = ? AND last_op_id = ?',
          a.orgId,
          'previous-operation',
        ),
      ).toEqual([]);
      expect(await rows('SELECT * FROM user_account WHERE org_id = ?', a.orgId)).toEqual(accounts);
    });

    it(`${variant}: rolls back all provisioning when the final grant insert fails`, async () => {
      await bootstrapAdmin(
        executor,
        b,
        input({
          userId: 'foreign-user',
          roleIds: ROLE_IDS_B,
        }),
      );
      const before = await snapshot(a);
      const foreignBefore = await snapshot(b);
      await expect(bootstrapSsoAdmin(executor, a, makeInput())).rejects.toThrow();
      expect(await snapshot(a)).toEqual(before);
      expect(await snapshot(b)).toEqual(foreignBefore);
    });

    it(`${variant}: tops up protected permissions once, bumping revision and epoch atomically`, async () => {
      await bootstrapSsoAdmin(executor, a, makeInput());
      const permission = 'org:projects:archive';
      await run(
        'DELETE FROM role_permission WHERE org_id = ? AND role_id = ? AND permission = ?',
        a.orgId,
        ROLE_IDS.organization_admin,
        permission,
      );
      const before = await rows<{ revision: number }>(
        'SELECT revision FROM role WHERE id = ?',
        ROLE_IDS.organization_admin,
      );
      const epoch = await rows('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId);
      expect(await bootstrapSsoAdmin(executor, a, { ...makeInput(), now: LATER })).toEqual({
        result: 'already_admin',
        toppedUp: 1,
      });
      expect(
        await rows('SELECT revision FROM role WHERE id = ?', ROLE_IDS.organization_admin),
      ).toEqual([{ revision: (before[0]?.revision ?? -1) + 1 }]);
      expect(await rows('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId)).not.toEqual(
        epoch,
      );
      expect(
        await rows(
          'SELECT permission FROM role_permission WHERE org_id = ? AND role_id = ? AND permission = ?',
          a.orgId,
          ROLE_IDS.organization_admin,
          permission,
        ),
      ).toEqual([{ permission }]);
      const topped = await snapshot(a);
      expect(await bootstrapSsoAdmin(executor, a, { ...makeInput(), now: LATER })).toEqual({
        result: 'already_admin',
        toppedUp: 0,
      });
      expect(await snapshot(a)).toEqual(topped);
    });
  }

  it('preserves an existing configured admin, linked identity and session', async () => {
    await bootstrapAdmin(executor, a, input());
    await run(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      'totp',
      a.orgId,
    );
    await run(
      'UPDATE local_login SET totp_credential_id = ?, totp_enabled_at = ?, totp_last_step = 57, credential_rev = 4 WHERE user_id = ?',
      'totp',
      NOW,
      input().userId,
    );

    await run(
      'UPDATE local_login SET password_hash = ?, failed_count = 3, locked_until = ? WHERE user_id = ?',
      PASSWORD_HASH,
      LATER,
      input().userId,
    );
    await run(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1)',
      'linked',
      a.orgId,
      input().userId,
      'dex',
      'subject',
      EMAIL,
    );
    await run(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'session',
      a.orgId,
      input().userId,
      'linked',
      HASH_2,
      HASH_3,
      LATER,
    );
    const before = await snapshot(a);
    await bootstrapSsoAdmin(executor, a, { ...emailInput(), now: LATER, userId: 'unused-user' });
    expect(await snapshot(a)).toEqual(before);
  });

  it('refuses a suspended email conflict without role top-up or account changes', async () => {
    await bootstrapAdmin(executor, a, input());
    await run("UPDATE user_account SET status = 'suspended' WHERE org_id = ?", a.orgId);
    await run(
      'DELETE FROM role_permission WHERE org_id = ? AND permission = ?',
      a.orgId,
      'org:projects:archive',
    );
    const before = await snapshot(a);
    await expect(bootstrapSsoAdmin(executor, a, emailInput())).rejects.toThrow();
    expect(await snapshot(a)).toEqual(before);
  });

  it('accepts a 256-code-point group without Unicode normalization', async () => {
    const value = '🦊'.repeat(256);
    await bootstrapSsoAdmin(executor, a, {
      ...groupInput(),
      subject: { type: 'group', provider: 'dex', value },
    });
    expect(await rows('SELECT subject_value FROM access_grant WHERE org_id = ?', a.orgId)).toEqual([
      { subject_value: value },
    ]);
  });

  it.each([
    { ...emailInput(), subject: { type: 'email' as const, value: 'private-invalid-email' } },
    { ...emailInput(), userId: 'private invalid id' },
    { ...groupInput(), now: 'private-invalid-time' },
    { ...groupInput(), grantId: '' },
    { ...groupInput(), roleIds: { ...ROLE_IDS, organization_admin: '' } },
  ])('validates all provisioning inputs before database access (%#)', async (invalid) => {
    const record = recording(executor);
    await expect(bootstrapSsoAdmin(record.executor, a, invalid)).rejects.toThrow(TypeError);
    expect(record.calls).toEqual({ all: 0, batch: 0 });
  });

  it('keeps provider and group case significant and never creates a group user', async () => {
    await bootstrapSsoAdmin(executor, a, groupInput());
    await bootstrapSsoAdmin(executor, a, {
      ...groupInput(),
      grantId: 'different-provider',
      subject: { type: 'group', provider: 'other', value: 'DevOps@example.test' },
    });
    await bootstrapSsoAdmin(executor, a, {
      ...groupInput(),
      grantId: 'different-case',
      subject: { type: 'group', provider: 'dex', value: 'devops@example.test' },
    });
    expect(await rows('SELECT id FROM access_grant WHERE org_id = ?', a.orgId)).toHaveLength(3);
    expect(await rows('SELECT * FROM user_account WHERE org_id = ?', a.orgId)).toEqual([]);
  });

  it.each(['', ' group', 'group ', 'x\n', 'x\u200b', 'x'.repeat(257)])(
    'rejects an invalid exact group without writes (%j)',
    async (value) => {
      const before = await snapshot(a);
      await expect(
        bootstrapSsoAdmin(executor, a, {
          ...groupInput(),
          subject: { type: 'group', provider: 'dex', value },
        }),
      ).rejects.toThrow('grant group must be 1 to 256 printable characters');
      expect(await snapshot(a)).toEqual(before);
    },
  );

  it.each(['', 'bad provider', undefined])(
    'requires a valid named provider (%j)',
    async (provider) => {
      const before = await snapshot(a);
      await expect(
        bootstrapSsoAdmin(executor, a, {
          ...groupInput(),
          subject: { type: 'group', provider: provider as string, value: 'private-group' },
        }),
      ).rejects.toThrow('grant provider must be a valid provider id');
      expect(await snapshot(a)).toEqual(before);
    },
  );
});
