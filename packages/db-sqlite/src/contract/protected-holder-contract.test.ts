import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import { rolePermissionProblems } from '@package-broker/core/authz/permissions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createGrantRepository,
  type ProtectedGrantRepository,
  type ProtectedHolderExclusion,
  type ProtectedHolderInput,
  type ProtectedHolderProvider,
} from '../repositories/grant.js';
import { createProjectGrantRepository, projectGrantKey } from '../repositories/project-grant.js';
import { createUnlinkRepository } from '../repositories/unlink.js';

const ANCHOR = 'oidc:https://idp.example.test';
const OIDC: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
  emailAuthoritativeDomains: ['example.test'],
};

const ADMIN = '01J0ROLEADMIN0000000000000';
const VIEWER = '01J0ROLEVIEWER000000000000';
const PROJECT_OWNER = '01J0ROLEPROJOWNER000000000';
const ADMIN_B = '01J0ROLEADMINB000000000000';

const OPERATOR = '01J0USEROPERATOR0000000000';
const OPERATOR_IDENTITY = '01J0IDENTOPERATOR000000000';
const OPERATOR_SESSION = '01J0SESSOPERATOR000000000';
const OPERATOR_GRANT = '01J0GRANTOPERATOR00000000';

const U1 = '01J0USER000000000000000001';
const U2 = '01J0USER000000000000000002';
const U3 = '01J0USER000000000000000003';
const UB = '01J0USER00000000000000000B';
const U1_IDENTITY = '01J0IDENTU1000000000000001';
const U2_IDENTITY = '01J0IDENTU2000000000000002';
const U2_SESSION = '01J0SESSU20000000000000002';

const G1 = '01J0GRANT00000000000000001';
const G2 = '01J0GRANT00000000000000002';
const G_ADMINS = '01J0GRANT0000000000000000G';
const G_EMPTY = '01J0GRANT0000000000000000E';
const G_EMPTY_TWO = '01J0GRANT0000000000000000F';
const G_PROJECT = '01J0GRANT0000000000000000P';
const G_B = '01J0GRANT0000000000000000B';

const P1 = '01J0PROJECT000000000000001';

let database: MigratedDatabase;
let directory: string;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let counter = 0;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function now(): string {
  return new Date().toISOString();
}

function fresh(exclude?: ProtectedHolderExclusion): ProtectedHolderInput {
  const base = { kind: 'fresh' as const, now: now(), providers: [OIDC] };
  return exclude === undefined ? base : { ...base, exclude };
}

const withoutOperator = (): ProtectedHolderInput => fresh({ identityId: OPERATOR_IDENTITY });

function repository(connection: SqlExecutor = executor): ProtectedGrantRepository {
  return createGrantRepository(connection, { holderInput: withoutOperator });
}

function user(org: OrgContext, id: string, email: string): Statement {
  return stmt(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'active')",
    id,
    org.orgId,
    email,
  );
}

function role(
  org: OrgContext,
  id: string,
  key: string,
  scope: 'organization' | 'project',
  protects: number,
  ...permissions: string[]
): Statement[] {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      org.orgId,
      key,
      key,
      scope,
      protects,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        org.orgId,
        id,
        permission,
      ),
    ),
  ];
}

function emailGrant(
  org: OrgContext,
  id: string,
  email: string,
  roleId: string,
  projectId: string | null = null,
): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)',
    id,
    org.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
    now(),
    now(),
  );
}

function groupGrant(id: string, group: string, roleId = ADMIN): Statement {
  return stmt(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, 'group', ?, 'oidc', 'organization', NULL, ?, NULL, ?, ?)",
    id,
    a.orgId,
    group,
    roleId,
    now(),
    now(),
  );
}

function member(userId: string, group: string): Statement {
  return stmt(
    "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'oidc', ?, ?)",
    a.orgId,
    userId,
    group,
    now(),
  );
}

function identity(org: OrgContext, userId: string, email: string, id?: string): Statement {
  counter += 1;
  return stmt(
    "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', ?, ?, 1, ?)",
    id ?? `01J0IDENTX${String(counter).padStart(16, '0')}`,
    org.orgId,
    userId,
    `subject-${userId}-${counter}`,
    email,
    now(),
  );
}

function session(id: string, userId: string): Statement {
  const hash = Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64);
  return stmt(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    userId,
    hash,
    hash,
    now(),
    new Date(Date.now() + 3_600_000).toISOString(),
  );
}

async function seed(...statements: Statement[]): Promise<void> {
  await executor.batch(statements);
}

function fence(
  expected: Record<string, number> = {},
  actor = OPERATOR,
  sessionId = OPERATOR_SESSION,
): MutationFence {
  return mutationFence({ userId: actor, sessionId } as unknown as AuthenticatedActor, expected);
}

async function revisionOf(grantId: string): Promise<number> {
  const found = await executor.all<{ revision: number }>(
    stmt('SELECT revision FROM access_grant WHERE id = ?', grantId),
  );
  return found[0]?.revision ?? 1;
}

async function holders(input: ProtectedHolderInput = withoutOperator()): Promise<number> {
  return repository().countProtectedHoldersFor(a, input);
}

async function twoAdmins(): Promise<void> {
  await seed(
    emailGrant(a, G1, 'u1@example.test', ADMIN),
    identity(a, U1, 'u1@example.test', U1_IDENTITY),
    emailGrant(a, G2, 'u2@example.test', ADMIN),
    identity(a, U2, 'u2@example.test', U2_IDENTITY),
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pb-holder-contract-'));
  database = await openMigratedDatabase({
    file: join(directory, 'store.sqlite'),
    twoOrganizations: true,
  });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await seed(
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      ANCHOR,
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      b.orgId,
      'oidc',
      ANCHOR,
    ),
    ...role(
      a,
      ADMIN,
      'organization_admin',
      'organization',
      1,
      'org:grants:write',
      'org:users:write',
      'project:grants:write',
      'project:read',
    ),
    ...role(a, VIEWER, 'org_viewer', 'organization', 0),
    ...role(
      a,
      PROJECT_OWNER,
      'project_owner',
      'project',
      1,
      'project:grants:write',
      'project:read',
    ),
    ...role(b, ADMIN_B, 'organization_admin', 'organization', 1),
    stmt(
      "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, 'alpha', 'alpha', 'active')",
      P1,
      a.orgId,
    ),
    user(a, OPERATOR, 'operator@example.test'),
    identity(a, OPERATOR, 'operator@example.test', OPERATOR_IDENTITY),
    emailGrant(a, OPERATOR_GRANT, 'operator@example.test', ADMIN),
    session(OPERATOR_SESSION, OPERATOR),
    user(a, U1, 'u1@example.test'),
    user(a, U2, 'u2@example.test'),
    user(a, U3, 'u3@example.test'),
    user(b, UB, 'b@example.test'),
  );
});

afterEach(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

describe('exact protected-user predicate', () => {
  it('ignores zero-member groups', async () => {
    await seed(emailGrant(a, G1, 'u1@example.test', ADMIN), identity(a, U1, 'u1@example.test'));
    expect(await holders()).toBe(1);

    await seed(groupGrant(G_EMPTY, 'nobody'), groupGrant(G_EMPTY_TWO, 'also-nobody'));

    expect(await holders()).toBe(1);
    expect(await repository().isProtectedHolder(a, U2, withoutOperator())).toBe(false);
  });

  it('counts each user once across overlapping holder contributions', async () => {
    await seed(
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(G_ADMINS, 'admins'),
      groupGrant(G_EMPTY, 'owners'),
      member(U1, 'admins'),
      member(U1, 'owners'),
      identity(a, U1, 'u1@example.test'),
      identity(a, U1, 'u1@example.test'),
      member(U2, 'admins'),
      identity(a, U2, 'u2@example.test'),
    );

    expect(await holders()).toBe(2);
    expect(await repository().isProtectedHolder(a, U1, withoutOperator())).toBe(true);
    expect(await repository().isProtectedHolder(a, U2, withoutOperator())).toBe(true);
    expect(await repository().isProtectedHolder(a, U3, withoutOperator())).toBe(false);
  });

  it('does not count a holder of another organization or an unprotected role', async () => {
    await seed(
      emailGrant(b, G_B, 'b@example.test', ADMIN_B),
      identity(b, UB, 'b@example.test'),
      emailGrant(a, G1, 'u1@example.test', VIEWER),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await holders()).toBe(0);
    expect(await repository().isProtectedHolder(a, UB, withoutOperator())).toBe(false);
  });
});

describe('freshness or LocalRecovery input is required', () => {
  it('rejects a call without the input at compile time and at run time', async () => {
    const grants = repository();

    // @ts-expect-error the freshness or LocalRecovery input has no default
    await expect(grants.isProtectedHolder(a, U1)).rejects.toThrow(TypeError);
    // @ts-expect-error the freshness or LocalRecovery input has no default
    await expect(grants.countProtectedHoldersFor(a)).rejects.toThrow(TypeError);
  });

  it('accepts the explicit LocalRecovery variant and counts only local e-mail eligibility', async () => {
    const credential = '01J0CREDU10000000000000001';
    await seed(
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      stmt(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
        credential,
        a.orgId,
      ),
      stmt(
        'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
        U1,
        a.orgId,
        'pbkdf2-sha256$test',
        credential,
        now(),
      ),
      groupGrant(G_ADMINS, 'admins'),
      member(U2, 'admins'),
      identity(a, U2, 'u2@example.test'),
    );
    const recovery: ProtectedHolderInput = { kind: 'local_recovery' };

    expect(await repository().isProtectedHolder(a, U1, recovery)).toBe(true);
    expect(await repository().isProtectedHolder(a, U2, recovery)).toBe(false);
    expect(await holders(recovery)).toBe(1);
  });
});

describe('project roles never protect a last holder', () => {
  it('removes the last Project Owner while the organization last holder stays protected', async () => {
    await seed(
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test'),
      emailGrant(a, G_PROJECT, 'u2@example.test', PROJECT_OWNER, P1),
      identity(a, U2, 'u2@example.test'),
    );
    expect(await repository().isProtectedHolder(a, U2, withoutOperator())).toBe(false);
    expect(await holders()).toBe(1);

    const removed = await createProjectGrantRepository(executor).delete(
      a,
      fence({ [projectGrantKey(G_PROJECT)]: await revisionOf(G_PROJECT) }),
      { id: G_PROJECT, projectId: P1, providerAnchors: [OIDC] },
    );
    const refused = await repository().deleteOrganization(
      a,
      fence({ grant: await revisionOf(G1) }),
      G1,
      'OP-ORG-LAST',
    );

    expect(removed).toMatchObject({ status: 'deleted' });
    expect(refused).toBe('last_holder');
    expect(await holders()).toBe(1);
  });

  it('refuses org:* permissions on a project-scope role', () => {
    expect(rolePermissionProblems('project', ['org:grants:write'])).not.toEqual([]);
    expect(rolePermissionProblems('project', ['project:grants:write', 'project:read'])).toEqual([]);
  });
});

describe('removing a contribution counts holders after exclusion', () => {
  beforeEach(async () => {
    await seed(
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(G_ADMINS, 'admins'),
      identity(a, U1, 'u1@example.test', U1_IDENTITY),
      member(U1, 'admins'),
    );
  });

  it('keeps a holder whose other contribution remains', async () => {
    const holdsWithout = (exclude: ProtectedHolderExclusion) =>
      repository().isProtectedHolder(a, U1, fresh(exclude));
    const membership = { userId: U1, provider: 'oidc', groupName: 'admins' };

    expect(await holdsWithout({ grantId: G1 })).toBe(true);
    expect(await holdsWithout({ grantId: G_ADMINS })).toBe(true);
    expect(await holdsWithout({ membership })).toBe(true);
    expect(await holdsWithout({ grantId: G1, membership })).toBe(false);
    expect(await holdsWithout({ identityId: U1_IDENTITY })).toBe(false);
    expect(await holders(fresh({ identityId: OPERATOR_IDENTITY, grantId: G1 }))).toBe(1);
  });

  it('lets the writer remove one contribution and refuses the last one', async () => {
    expect(
      await repository().deleteOrganization(a, fence({ grant: await revisionOf(G1) }), G1, 'OP-1'),
    ).toBe('deleted');
    expect(await holders()).toBe(1);
    expect(
      await repository().deleteOrganization(
        a,
        fence({ grant: await revisionOf(G_ADMINS) }),
        G_ADMINS,
        'OP-2',
      ),
    ).toBe('last_holder');
    expect(await holders()).toBe(1);
  });
});

describe('concurrent last-admin operations', () => {
  function held(connection: SqlExecutor) {
    let release!: () => void;
    let arrive!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gated: SqlExecutor = {
      driver: connection.driver,
      all: (statement) => connection.all(statement),
      batch: async (statements) => {
        arrive();
        await open;
        return connection.batch(statements);
      },
    };
    return { executor: gated, reached, release };
  }

  type Operation = (connection: SqlExecutor) => Promise<string>;

  async function inOrder(
    left: Operation,
    right: Operation,
    leftFirst: boolean,
  ): Promise<[string, string]> {
    const second = await database.second();
    const leftGate = held(executor);
    const rightGate = held(second);
    const running = [left(leftGate.executor), right(rightGate.executor)] as const;
    await Promise.all([leftGate.reached, rightGate.reached]);
    const [firstGate, firstRun, lastGate] = leftFirst
      ? [leftGate, running[0], rightGate]
      : [rightGate, running[1], leftGate];
    firstGate.release();
    await firstRun;
    lastGate.release();
    const [l, r] = await Promise.all(running);
    return [l, r];
  }

  const SUCCESS = new Set(['deleted', 'suspended', 'unlinked']);

  async function deleteOf(grantId: string, connection: SqlExecutor): Promise<string> {
    counter += 1;
    return repository(connection).deleteOrganization(
      a,
      fence({ grant: await revisionOf(grantId) }),
      grantId,
      `OP-${counter}`,
    );
  }

  const suspendOf = (userId: string) => (connection: SqlExecutor) =>
    repository(connection).suspendUser(a, fence({ grant: 1 }), userId, now());

  async function unlinkU1(connection: SqlExecutor): Promise<string> {
    const found = await connection.all<{ subject: string }>(
      stmt('SELECT subject FROM identity WHERE id = ?', U1_IDENTITY),
    );
    return createUnlinkRepository(connection, { holderInput: withoutOperator }).unlinkIdentity(
      a,
      fence({}, U2, U2_SESSION),
      {
        identityId: U1_IDENTITY,
        userId: U1,
        provider: 'oidc',
        subject: found[0]?.subject ?? '',
        anchor: ANCHOR,
        now: now(),
      },
    );
  }

  const scenarios: readonly (readonly [string, Operation, Operation])[] = [
    ['delete vs delete', (c) => deleteOf(G1, c), (c) => deleteOf(G2, c)],
    ['suspend vs suspend', suspendOf(U1), suspendOf(U2)],
    ['delete vs suspend', (c) => deleteOf(G1, c), suspendOf(U2)],
    ['unlink vs delete', unlinkU1, (c) => deleteOf(G2, c)],
  ];

  for (const [name, left, right] of scenarios) {
    for (const leftFirst of [true, false]) {
      it(`${name}: only one commits, ${leftFirst ? 'left' : 'right'} first`, async () => {
        await twoAdmins();
        await seed(session(U2_SESSION, U2));

        const outcomes = await inOrder(left, right, leftFirst);

        expect(outcomes.filter((outcome) => SUCCESS.has(outcome))).toHaveLength(1);
        expect(SUCCESS.has(leftFirst ? outcomes[0] : outcomes[1])).toBe(true);
        expect(await holders()).toBe(1);
      });
    }
  }
});
