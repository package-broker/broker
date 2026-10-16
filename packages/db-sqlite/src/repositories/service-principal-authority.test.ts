import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { ProtectedHolderProvider } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  servicePrincipalAuthorityGuard,
  type ServicePrincipalGuardInput,
} from './service-principal-authority.js';
import {
  createServicePrincipalRepository,
  type ServicePrincipalRepository,
} from './service-principal.js';

const NOW = '2026-10-15T12:00:00.000Z';
const USER = '01J0USER000000000000000001';
const SESSION = '01J0SESSION000000000000001';
const PA = '01J0PROJECT00000000000000A1';
const SP = '01J0SERVICEPRINCIPAL0000A1';
const MANAGER_ROLE = '01J0ROLEMANAGER0000000000A1';
const ADMIN_ROLE = '01J0ROLEADMIN000000000000A1';
const ORG_OPS_ROLE = '01J0ROLEORGOPS00000000000A1';

const ANCHORS: readonly ProtectedHolderProvider[] = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
];

let directory: string;
let database: MigratedDatabase;
let a: OrgContext;
let executor: SqlExecutor;
let principals: ServicePrincipalRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

async function rows(sql: string, ...params: Statement['params']): Promise<unknown[]> {
  return executor.all(stmt(sql, ...params));
}

function role(id: string, scope: string, protects: number, permissions: readonly string[]) {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      a.orgId,
      id.toLowerCase(),
      id,
      scope,
      protects,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        id,
        permission,
      ),
    ),
  ];
}

function grant(id: string, roleId: string, projectId: string | null) {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    'email',
    'u1@example.test',
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
    NOW,
    NOW,
  );
}

const fence = (userId = USER, sessionId = SESSION, expected: Record<string, number> = {}) =>
  mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, expected);

function gated() {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executorGate: SqlExecutor = {
    driver: executor.driver,
    all: (statement) => executor.all(statement),
    batch: async (statements) => {
      reached();
      await open;
      return executor.batch(statements);
    },
  };
  return { executor: executorGate, arrived, release };
}

const PROJECT_MANAGE: ServicePrincipalGuardInput = {
  permission: 'project:service-principals:write',
  projectId: PA,
  organizationAdmin: false,
  covers: ['project:packages:read'],
  providerAnchors: ANCHORS,
};
const ORG_MANAGE: ServicePrincipalGuardInput = {
  permission: 'org:service-principals:write',
  projectId: null,
  organizationAdmin: true,
  covers: ['org:read', 'project:packages:read'],
  providerAnchors: ANCHORS,
};

function createWith(input: ServicePrincipalGuardInput, f = fence(), projectId = input.projectId) {
  return principals.create(a, f, servicePrincipalAuthorityGuard(a, f, input), {
    id: SP,
    name: 'ci',
    projectId,
    createdByUserId: USER,
    permissions: projectId === null ? ['org:read'] : ['project:packages:read'],
    now: NOW,
    opId: 'op-create',
  });
}

async function stored(): Promise<number> {
  return (await rows('SELECT id FROM service_principal')).length;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pb-sp-authority-'));
  database = await openMigratedDatabase({
    file: join(directory, 'store.sqlite'),
    twoOrganizations: true,
  });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  a = database.orgs.a;
  executor = database.executor;
  principals = createServicePrincipalRepository(executor);
  const hash = 'a'.repeat(64);
  await executor.batch([
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      USER,
      a.orgId,
      'u1@example.test',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      PA,
      a.orgId,
      'alpha',
      'alpha',
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      'oidc:https://idp.example.test',
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      '01J0IDENT00000000000000001',
      a.orgId,
      USER,
      'oidc',
      'subject-1',
      'u1@example.test',
      new Date(Date.now() - 60_000).toISOString(),
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      USER,
      hash,
      hash,
      new Date().toISOString(),
      new Date().toISOString(),
      '2999-01-01T00:00:00.000Z',
    ),
    ...role(MANAGER_ROLE, 'project', 0, [
      'project:service-principals:write',
      'project:packages:read',
      'project:read',
    ]),
    ...role(ADMIN_ROLE, 'organization', 1, [
      'org:service-principals:write',
      'org:read',
      'project:packages:read',
    ]),
    ...role(ORG_OPS_ROLE, 'organization', 0, [
      'org:service-principals:write',
      'org:read',
      'project:packages:read',
    ]),
  ]);
});

afterEach(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

describe('servicePrincipalAuthorityGuard', () => {
  it('commits a project create for a manager whose live set covers the snapshot', async () => {
    await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
    expect(await createWith(PROJECT_MANAGE)).toBe('created');
    expect(await stored()).toBe(1);
  });

  it('refuses and stores nothing when a covered permission is not held', async () => {
    await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
    const result = await createWith({ ...PROJECT_MANAGE, covers: ['project:sources:read'] });
    expect(result).toBe('authority');
    expect(await stored()).toBe(0);
  });

  it('refuses without the management permission', async () => {
    await executor.batch([
      ...role('01J0ROLEREADER0000000000A1', 'project', 0, ['project:packages:read']),
      grant('G1', '01J0ROLEREADER0000000000A1', PA),
    ]);
    expect(await createWith(PROJECT_MANAGE)).toBe('authority');
    expect(await stored()).toBe(0);
  });

  it('refuses an archived project', async () => {
    await executor.batch([
      grant('G1', MANAGER_ROLE, PA),
      stmt("UPDATE project SET status = 'archived' WHERE id = ?", PA),
    ]);
    expect(await createWith(PROJECT_MANAGE)).toBe('authority');
  });

  it('lets an archived project through only with allowArchived', async () => {
    await executor.batch([
      grant('G1', MANAGER_ROLE, PA),
      stmt("UPDATE project SET status = 'archived' WHERE id = ?", PA),
    ]);
    const f = fence();
    await executor.batch([
      stmt(
        'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        SP,
        a.orgId,
        'ci',
        PA,
        USER,
        NOW,
        NOW,
      ),
    ]);
    const refused = await principals.suspend(
      a,
      f,
      servicePrincipalAuthorityGuard(a, f, { ...PROJECT_MANAGE, covers: [] }),
      SP,
      NOW,
      'op-1',
    );
    expect(refused).toBe('authority');
    const allowed = await principals.suspend(
      a,
      f,
      servicePrincipalAuthorityGuard(a, f, { ...PROJECT_MANAGE, covers: [], allowArchived: true }),
      SP,
      NOW,
      'op-2',
    );
    expect(allowed).toBe('suspended');
  });

  it('requires a live organization admin for an organization-wide principal', async () => {
    await executor.batch([grant('G1', ORG_OPS_ROLE, null)]);
    expect(await createWith(ORG_MANAGE)).toBe('authority');
    expect(await stored()).toBe(0);
  });

  it('commits an organization-wide create for an admin and covers project: names from org grants', async () => {
    await executor.batch([grant('G1', ADMIN_ROLE, null)]);
    expect(await createWith(ORG_MANAGE)).toBe('created');
    expect(await stored()).toBe(1);
  });

  it('refuses when the session is revoked, belongs to another user or is unknown', async () => {
    await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
    expect(await createWith(PROJECT_MANAGE, fence(USER, 'unknown-session'))).toBe('authority');
    await rows('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, SESSION);
    expect(await createWith(PROJECT_MANAGE)).toBe('authority');
    expect(await stored()).toBe(0);
  });

  it('refuses when the acting user is suspended', async () => {
    await executor.batch([
      grant('G1', MANAGER_ROLE, PA),
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", USER),
    ]);
    expect(await createWith(PROJECT_MANAGE)).toBe('authority');
  });

  it('keeps every guard statement within the 100 bound-parameter limit', () => {
    for (const input of [PROJECT_MANAGE, ORG_MANAGE]) {
      const guard = servicePrincipalAuthorityGuard(a, fence(), input);
      for (const statement of guard) expect(statement.params.length).toBeLessThanOrEqual(100);
    }
  });

  it('rejects session-only covered permissions', () => {
    expect(() =>
      servicePrincipalAuthorityGuard(a, fence(), {
        ...PROJECT_MANAGE,
        covers: ['project:service-principals:write'],
      }),
    ).toThrow(TypeError);
  });

  it('rejects malformed requirements before building SQL', () => {
    const f = fence();
    expect(() =>
      servicePrincipalAuthorityGuard(a, f, { ...PROJECT_MANAGE, covers: ['project:nope'] }),
    ).toThrow(TypeError);
    expect(() =>
      servicePrincipalAuthorityGuard(a, f, { ...PROJECT_MANAGE, permission: 'project:nope' }),
    ).toThrow(TypeError);
    expect(() =>
      servicePrincipalAuthorityGuard(a, f, { ...PROJECT_MANAGE, projectId: '' }),
    ).toThrow(TypeError);
    expect(() =>
      servicePrincipalAuthorityGuard(a, f, {
        ...PROJECT_MANAGE,
        providerAnchors: undefined as never,
      }),
    ).toThrow(TypeError);
  });

  it('refuses a batch when the actor loses a covered permission after the service read', async () => {
    await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
    const rival = await database.second();
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        reached();
        await open;
        return executor.batch(statements);
      },
    };
    const f = fence();
    const guard = servicePrincipalAuthorityGuard(a, f, PROJECT_MANAGE);
    const racing = createServicePrincipalRepository(gated).create(a, f, guard, {
      id: SP,
      name: 'ci',
      projectId: PA,
      createdByUserId: USER,
      permissions: ['project:packages:read'],
      now: NOW,
      opId: 'op-race',
    });
    await arrived;
    await rival.batch([
      stmt(
        'DELETE FROM role_permission WHERE role_id = ? AND permission = ?',
        MANAGER_ROLE,
        'project:packages:read',
      ),
    ]);
    release();
    expect(await racing).toBe('authority');
    expect(await stored()).toBe(0);
    expect(await rows('SELECT * FROM service_principal_permission')).toEqual([]);
  });

  describe('restore', () => {
    async function suspended(permissions: readonly string[]) {
      await executor.batch([
        stmt(
          "INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'suspended', ?, ?)",
          SP,
          a.orgId,
          'ci',
          PA,
          USER,
          NOW,
          NOW,
        ),
        ...permissions.map((permission) =>
          stmt(
            'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
            a.orgId,
            SP,
            permission,
          ),
        ),
      ]);
    }

    function restoreWith(f = fence(USER, SESSION, { service_principal: 1 })) {
      const guard = servicePrincipalAuthorityGuard(a, f, {
        ...PROJECT_MANAGE,
        covers: [],
        coversStoredOf: SP,
      });
      return { f, guard };
    }

    async function statusOf(): Promise<unknown> {
      return rows('SELECT status, revision FROM service_principal WHERE id = ?', SP);
    }

    it('restores when the actor covers the stored set', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      await suspended(['project:packages:read']);
      const { f, guard } = restoreWith();
      expect(await principals.restore(a, f, guard, SP, NOW, 'op-r')).toBe('restored');
      expect(await statusOf()).toEqual([{ status: 'active', revision: 2 }]);
    });

    it('refuses and stays suspended when the stored set is not covered', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      await suspended(['project:packages:read', 'project:sources:read']);
      const { f, guard } = restoreWith();
      expect(await principals.restore(a, f, guard, SP, NOW, 'op-r')).toBe('authority');
      expect(await statusOf()).toEqual([{ status: 'suspended', revision: 1 }]);
    });

    it('refuses with conflict on a stale revision and stays suspended', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      await suspended(['project:packages:read']);
      const { f, guard } = restoreWith(fence(USER, SESSION, { service_principal: 7 }));
      expect(await principals.restore(a, f, guard, SP, NOW, 'op-r')).toBe('conflict');
      expect(await statusOf()).toEqual([{ status: 'suspended', revision: 1 }]);
    });

    it('refuses when a rival widens the stored set between the read and the commit', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      await suspended(['project:packages:read']);
      const rival = await database.second();
      const gate = gated();
      const { f, guard } = restoreWith();
      const racing = createServicePrincipalRepository(gate.executor).restore(
        a,
        f,
        guard,
        SP,
        NOW,
        'op-r',
      );
      await gate.arrived;
      await rival.batch([
        stmt(
          'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          SP,
          'project:sources:read',
        ),
      ]);
      gate.release();
      expect(await racing).toBe('authority');
      expect(await statusOf()).toEqual([{ status: 'suspended', revision: 1 }]);
    });

    it('answers not_found for an unknown id carrying an expected revision', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      const { f, guard } = restoreWith();
      expect(await principals.restore(a, f, guard, SP, NOW, 'op-r')).toBe('not_found');
      const stop = fence(USER, SESSION, { service_principal: 1 });
      const stopGuard = servicePrincipalAuthorityGuard(a, stop, { ...PROJECT_MANAGE, covers: [] });
      expect(await principals.suspend(a, stop, stopGuard, SP, NOW, 'op-s')).toBe('not_found');
    });

    it('answers not_found when a rival deletes the principal between the read and the commit', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      await suspended(['project:packages:read']);
      const rival = await database.second();
      const gate = gated();
      const { f, guard } = restoreWith();
      const racing = createServicePrincipalRepository(gate.executor).restore(
        a,
        f,
        guard,
        SP,
        NOW,
        'op-r',
      );
      await gate.arrived;
      await rival.batch([stmt('DELETE FROM service_principal WHERE id = ?', SP)]);
      gate.release();
      expect(await racing).toBe('not_found');
      expect(await rows('SELECT id FROM service_principal')).toEqual([]);
    });

    it('refuses with conflict when a rival bumps the revision between the read and the commit', async () => {
      await executor.batch([grant('G1', MANAGER_ROLE, PA)]);
      await suspended(['project:packages:read']);
      const rival = await database.second();
      const gate = gated();
      const { f, guard } = restoreWith();
      const racing = createServicePrincipalRepository(gate.executor).restore(
        a,
        f,
        guard,
        SP,
        NOW,
        'op-r',
      );
      await gate.arrived;
      await rival.batch([
        stmt('UPDATE service_principal SET revision = revision + 1 WHERE id = ?', SP),
      ]);
      gate.release();
      expect(await racing).toBe('conflict');
      expect(await statusOf()).toEqual([{ status: 'suspended', revision: 2 }]);
    });
  });
});
