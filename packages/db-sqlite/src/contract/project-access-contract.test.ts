import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { createProjectAdministration } from '@package-broker/core/authz/project-administration';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import { createProjectService } from '@package-broker/core/authz/project-service';
import { buildOrganizationActor } from '@package-broker/core/authz/actor';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { fixedClock } from '@package-broker/core/ids';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createAccessRepository } from '../repositories/access.js';
import {
  createProjectGrantRepository,
  projectGrantKey,
  projectGrantRoleKey,
} from '../repositories/project-grant.js';
import { createProjectRepository } from '../repositories/project.js';
import { createRoleRepository as createFencedRoleRepository } from '../repositories/role.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';

const id = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, '0')}`;
const USER = id(1),
  SESSION = id(2),
  A = id(3),
  B = id(4),
  ARCHIVED = id(5),
  FOREIGN = id(6);
const OWNER = id(7),
  VIEWER = id(8),
  BROAD = id(9),
  ORG_ROLE = id(10),
  TARGET = id(11);
const anchors = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
];
const origin = 'https://broker.example.test';
const sessionSecret = 'A'.repeat(43),
  csrf = 'B'.repeat(43);
let database: MigratedDatabase;
let org: OrgContext;
let foreign: OrgContext;
let nextId: number;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const rows = <T = Record<string, unknown>>(sql: string, ...params: Statement['params']) =>
  database.executor.all<T>(stmt(sql, ...params));
const fence = (expected: Record<string, number> = {}) =>
  mutationFence({ userId: USER, sessionId: SESSION } as AuthenticatedActor, expected);
const actor = (projectId = A): ProjectActor => ({
  kind: 'project',
  orgId: org.orgId,
  userId: USER,
  projectId,
  permissions: new Set(['project:read', 'project:grants:write', 'project:settings:write']),
});
const admin = (providerAnchors = anchors) =>
  createProjectAdministration({
    grants: createProjectGrantRepository(database.executor),
    providers: new Map([['oidc', true]]),
    providerAnchors,
    clock: fixedClock(new Date().toISOString()),
    ids: { ulid: () => id(nextId++) },
    log: () => {},
  });
const input = (roleId = VIEWER) => ({
  subject: { type: 'group' as const, provider: 'oidc', value: 'new-team' },
  roleId,
});

function grant(grantId: string, roleId: string, projectId: string | null, group = 'ops') {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_provider, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    grantId,
    org.orgId,
    'group',
    'oidc',
    group,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
  );
}

async function snapshot() {
  return JSON.stringify(
    await Promise.all(
      [
        'access_grant',
        'project',
        'role',
        'role_permission',
        'cache_epoch',
        'access_mutation_guard',
      ].map((table) => rows(`SELECT * FROM ${table} ORDER BY 1`)),
    ),
  );
}

function engine() {
  return createAuthorizationEngine({
    access: createAccessRepository(database.executor),
    patValidation: patValidationGate,
    publicOrigin: origin,
    providerAnchors: async () => anchors,
    tokenUse: {
      keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
      nowMs: Date.now,
      dispatch: () => {},
      log: () => {},
    },
  });
}

function request(
  slug: string,
  permission = 'project:read',
  method = 'GET',
  boundary: 'project' | 'organization' = 'project',
) {
  return {
    org,
    params: { project: slug },
    route: { plugin: 'contract', method, path: '/:project/packages.json', permission, boundary },
    request: new Request(`${origin}/${slug}/packages.json`, {
      method,
      headers: { cookie: `${SESSION_COOKIE}=${sessionSecret}`, origin, 'x-csrf-token': csrf },
    }),
  };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations required');
  org = database.orgs.a;
  foreign = database.orgs.b;
  nextId = 100;
  const now = new Date().toISOString();
  const statements: Statement[] = [
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      USER,
      org.orgId,
      'actor@example.test',
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      org.orgId,
      USER,
      await sha256Hex(sessionSecret),
      await sha256Hex(csrf),
      now,
      now,
      '2999-01-01T00:00:00.000Z',
      now,
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      org.orgId,
      'oidc',
      anchors[0]!.anchor,
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      id(20),
      org.orgId,
      USER,
      'oidc',
      'actor',
      'actor@example.test',
      now,
    ),
    stmt(
      'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
      org.orgId,
      USER,
      'oidc',
      'ops',
      now,
    ),
  ];
  for (const [projectId, slug, ctx, status] of [
    [A, 'alpha', org, 'active'],
    [B, 'beta', org, 'active'],
    [ARCHIVED, 'archived', org, 'archived'],
    [FOREIGN, 'foreign', foreign, 'active'],
  ] as const) {
    statements.push(
      stmt(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        projectId,
        ctx.orgId,
        slug,
        slug,
        status,
      ),
    );
  }
  for (const [roleId, key, scope, permissions] of [
    [OWNER, 'owner', 'project', ['project:read', 'project:grants:write', 'project:settings:write']],
    [VIEWER, 'viewer', 'project', ['project:read']],
    [BROAD, 'broad', 'project', ['project:read', 'project:tokens:create']],
    [
      ORG_ROLE,
      'organization',
      'organization',
      [
        'project:read',
        'project:settings:write',
        'org:projects:archive',
        'org:roles:write',
        'org:read',
      ],
    ],
  ] as const) {
    statements.push(
      stmt(
        'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        roleId,
        org.orgId,
        key,
        key,
        scope,
      ),
    );
    for (const permission of permissions)
      statements.push(
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          org.orgId,
          roleId,
          permission,
        ),
      );
  }
  statements.push(
    grant(id(21), OWNER, A),
    grant(id(22), OWNER, ARCHIVED),
    stmt(
      'INSERT INTO access_grant (id, org_id, subject_type, subject_provider, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      TARGET,
      org.orgId,
      'group',
      'oidc',
      'target',
      'project',
      ARCHIVED,
      VIEWER,
    ),
  );
  await database.executor.batch(statements);
});
afterEach(async () => {
  await database.close();
});

describe('project access with real persistence', () => {
  it('allows A reads and writes, conceals B, and widens only after an organization grant', async () => {
    const auth = engine();
    for (const [permission, method] of [
      ['project:read', 'GET'],
      ['project:settings:write', 'POST'],
    ] as const) {
      expect(await auth.authorize(request('alpha', permission, method))).toMatchObject({
        allow: true,
        projectId: A,
      });
      expect(await auth.authorize(request('beta', permission, method))).toEqual({
        allow: false,
        status: 404,
      });
    }
    const projects = createProjectService({
      projects: createProjectRepository(database.executor, { providerAnchors: anchors }),
      clock: fixedClock(new Date().toISOString()),
      ids: { ulid: () => id(nextId++) },
      log: () => {},
    });
    const before = await snapshot();
    expect(
      await projects.updateSettings(org, actor(), fence({ project: 1 }), B, { name: 'Changed' }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(await admin().grant(org, actor(), fence(), B, input())).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await snapshot()).toBe(before);
    await database.executor.batch([grant(id(23), ORG_ROLE, null)]);
    for (const [permission, method] of [
      ['project:read', 'GET'],
      ['project:settings:write', 'POST'],
    ] as const)
      expect(await auth.authorize(request('beta', permission, method))).toMatchObject({
        allow: true,
        projectId: B,
      });
  });

  it.each(['missing', 'foreign', 'archived', '%61lpha', 'alph%61', '%2561lpha', 'alpha%2fbeta'])(
    'uniformly conceals %s on project reads and writes even from an organization grant',
    async (slug) => {
      await database.executor.batch([grant(id(23), ORG_ROLE, null)]);
      for (const [permission, method] of [
        ['project:read', 'GET'],
        ['project:settings:write', 'POST'],
      ] as const)
        expect(await engine().authorize(request(slug, permission, method))).toEqual({
          allow: false,
          status: 404,
        });
    },
  );

  it('permits organization-boundary inspection and restore after reauthentication', async () => {
    await database.executor.batch([grant(id(23), ORG_ROLE, null)]);
    expect(
      await engine().authorize(request('archived', 'org:read', 'GET', 'organization')),
    ).toMatchObject({ allow: true, projectId: null });
    const repository = createProjectRepository(database.executor, { providerAnchors: anchors });
    expect(await repository.get(org, ARCHIVED)).toMatchObject({ id: ARCHIVED, status: 'archived' });
    const access = await createAccessRepository(database.executor).lookupSession(org, {
      boundary: 'organization',
      projectSlug: null,
      secretHash: await sha256Hex(sessionSecret),
      providerAnchors: anchors,
    });
    if (access === null) throw new Error('session required');
    const organizationActor = buildOrganizationActor('organization', access);
    if (organizationActor === null) throw new Error('organization actor required');
    const service = createProjectService({
      projects: repository,
      clock: fixedClock(new Date().toISOString()),
      ids: { ulid: () => id(nextId++) },
      log: () => {},
    });
    await rows('UPDATE session SET reauth_at = NULL WHERE id = ?', SESSION);
    expect(
      await service.restoreProject(org, organizationActor, fence({ project: 1 }), ARCHIVED),
    ).toEqual({ ok: false, error: 'forbidden' });
    await rows('UPDATE session SET reauth_at = ? WHERE id = ?', new Date().toISOString(), SESSION);
    expect(
      await service.restoreProject(org, organizationActor, fence({ project: 1 }), ARCHIVED),
    ).toEqual({ ok: true, value: null });
    expect(await engine().authorize(request('archived'))).toMatchObject({
      allow: true,
      projectId: ARCHIVED,
    });
  });

  it('rejects project roles containing organization permissions at the real role writer', async () => {
    for (const permission of ['org:*', 'org:read', 'org:roles:write']) {
      const before = await snapshot();
      expect(
        await createFencedRoleRepository(database.executor, { providerAnchors: anchors }).create(
          org,
          fence(),
          {
            id: id(nextId++),
            key: 'invalid',
            name: 'Invalid',
            scope: 'project',
            permissions: [permission],
            now: new Date().toISOString(),
            opId: id(nextId++),
          },
        ),
      ).toBe('invalid_permissions');
      expect(await snapshot()).toBe(before);
    }
  });

  it('enforces the live permission subset behind project administration', async () => {
    const before = await snapshot();
    expect(await admin().grant(org, actor(), fence(), A, input(BROAD))).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await snapshot()).toBe(before);
    expect(await admin().grant(org, actor(), fence(), A, input())).toMatchObject({ ok: true });
  });

  it('denies archived grants but permits archived revocation with the repository fence key', async () => {
    const service = admin();
    const before = await snapshot();
    expect(await service.grant(org, actor(ARCHIVED), fence(), ARCHIVED, input())).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await service.revoke(org, actor(ARCHIVED), fence({ grant: 1 }), ARCHIVED, TARGET),
    ).toEqual({ ok: false, error: 'invalid_revision' });
    expect(await snapshot()).toBe(before);
    expect(projectGrantKey(TARGET)).toBe(`access_grant:${TARGET}`);
    expect(
      await service.revoke(
        org,
        actor(ARCHIVED),
        fence({ [projectGrantKey(TARGET)]: 1 }),
        ARCHIVED,
        TARGET,
      ),
    ).toEqual({ ok: true, value: null });
    expect(await rows('SELECT id FROM access_grant WHERE id = ?', TARGET)).toEqual([]);
  });

  it('uses access_grant and role fence keys for role changes and rejects stale revisions', async () => {
    const service = admin();
    const created = await service.grant(org, actor(), fence(), A, input());
    if (!created.ok) throw new Error('grant required');
    const grantId = created.value.id;
    expect(projectGrantRoleKey(VIEWER)).toBe(`role:${VIEWER}`);
    const beforeSubset = await snapshot();
    expect(
      await service.changeRole(
        org,
        actor(),
        fence({ [projectGrantKey(grantId)]: 1, [projectGrantRoleKey(BROAD)]: 1 }),
        A,
        grantId,
        BROAD,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(await snapshot()).toBe(beforeSubset);
    const before = await snapshot();
    expect(
      await service.changeRole(org, actor(), fence({ grant: 1, role: 1 }), A, grantId, VIEWER),
    ).toEqual({ ok: false, error: 'invalid_revision' });
    expect(
      await service.changeRole(
        org,
        actor(),
        fence({ [projectGrantKey(grantId)]: 2, [projectGrantRoleKey(VIEWER)]: 1 }),
        A,
        grantId,
        VIEWER,
      ),
    ).toEqual({ ok: false, error: 'conflict' });
    expect(await snapshot()).toBe(before);
    expect(
      await service.changeRole(
        org,
        actor(),
        fence({ [projectGrantKey(grantId)]: 1, [projectGrantRoleKey(VIEWER)]: 1 }),
        A,
        grantId,
        VIEWER,
      ),
    ).toEqual({ ok: true, value: null });
  });

  it.each([
    'missing',
    'changed',
    'wrong-provider',
    'stale-group',
    'stale-identity',
    'unverified',
    'changed-email',
  ])('passes provider anchors through and refuses %s evidence', async (failure) => {
    let configured = anchors;
    if (failure === 'missing') configured = [];
    if (failure === 'changed')
      configured = [{ ...anchors[0]!, anchor: 'oidc:https://rebound.example.test' }];
    if (failure === 'wrong-provider') await rows("UPDATE user_group SET provider = 'other'");
    if (failure === 'stale-group')
      await rows("UPDATE user_group SET refreshed_at = '2000-01-01T00:00:00.000Z'");
    if (failure === 'stale-identity')
      await rows("UPDATE identity SET validated_at = '2000-01-01T00:00:00.000Z'");
    if (failure === 'unverified') await rows('UPDATE identity SET email_verified = 0');
    if (failure === 'changed-email')
      await rows("UPDATE identity SET email = 'changed@example.test'");
    await database.executor.batch([grant(id(24), VIEWER, A, 'target')]);
    const service = admin(configured);
    const before = await snapshot();
    const created = await service.grant(org, actor(), fence(), A, input());
    expect(created).toEqual({
      ok: false,
      error: failure === 'missing' ? 'unknown_provider' : 'forbidden',
    });
    expect(
      await service.changeRole(
        org,
        actor(),
        fence({ [projectGrantKey(id(24))]: 1, [projectGrantRoleKey(VIEWER)]: 1 }),
        A,
        id(24),
        VIEWER,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await service.revoke(
        org,
        actor(ARCHIVED),
        fence({ [projectGrantKey(TARGET)]: 1 }),
        ARCHIVED,
        TARGET,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(await snapshot()).toBe(before);
  });
});
