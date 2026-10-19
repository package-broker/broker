import type { ApiCall, IdempotencyRecord } from '../api/idempotency.js';
import type { AuditEvent } from '../audit/actions.js';
import { describe, expect, it, vi } from 'vitest';
import type { GrantRepository, OrganizationGrant } from '../db/grants.js';
import { orgContext } from '../db/port.js';
import type { OrgContext } from '../db/port.js';
import type { Role, RoleRepository } from '../db/roles.js';
import type { User } from '../db/users.js';
import { fixedClock } from '../ids.js';
import type { Clock } from '../ids.js';
import { normalizeEmail } from '../identity/policy.js';
import type { IdentityProvider } from '../identity/port.js';
import { createAdministration, type AdministrationDeps } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import type { ActorContext } from './administration.js';
import { DEFAULT_ROLES, PERMISSIONS } from './permissions.js';

const ctx: OrgContext = orgContext('org-a');
const NOW = '2026-10-15T08:00:00.000Z';
const ULIDS = Array.from({ length: 50 }, (_, index) => `ID${String(index).padStart(2, '0')}`);

const ALL = PERMISSIONS.map(({ name }) => name);
const administrator: ActorContext = {
  kind: 'organization',
  userId: 'admin-1',
  permissions: new Set(ALL),
  isOrganizationAdmin: true,
};
const actorWith = (...permissions: string[]): ActorContext => ({
  kind: 'organization',
  userId: 'actor-1',
  permissions: new Set(permissions),
  isOrganizationAdmin: false,
});
const heldBy = (userId: string) => expect.objectContaining({ userId, sessionId: 'session-1' });

function fenceFor(actor: unknown) {
  const userId = (actor as { userId?: unknown } | null)?.userId;
  return mutationFence(
    {
      userId: typeof userId === 'string' && userId !== '' ? userId : 'unknown',
      sessionId: 'session-1',
    } as unknown as AuthenticatedActor,
    { role: 1, grant: 1 },
  );
}
const grantsWriter = actorWith('org:grants:write', 'org:read');
const rolesWriter = actorWith('org:roles:write', 'org:read', 'project:read');
const usersWriter = actorWith('org:users:write');

const customRole = (overrides: Partial<Role> = {}): Role => ({
  id: 'role-1',
  key: 'ops',
  name: 'Ops',
  scope: 'organization',
  isSystem: false,
  protectsLastHolder: false,
  revision: 1,
  permissions: ['org:read'],
  ...overrides,
});
const adminRole = customRole({
  id: 'role-admin',
  key: 'organization_admin',
  isSystem: true,
  protectsLastHolder: true,
  permissions: ALL,
});
const grantOf = (id: string, roleId: string, value = 'someone@example.com'): OrganizationGrant => ({
  id,
  subject: { type: 'email', value },
  roleId,
  createdBy: null,
  createdAt: NOW,
  revision: 1,
});
const userOf = (overrides: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'target@example.com',
  displayName: null,
  status: 'active',
  lastLoginAt: null,
  createdAt: NOW,
  ...overrides,
});

function setup(
  overrides: {
    roles?: Partial<Record<keyof RoleRepository, unknown>>;
    grants?: Partial<Record<keyof GrantRepository, unknown>>;
    users?: { get?: unknown };
    clock?: Clock;
    stored?: readonly Role[];
    storedGrants?: readonly OrganizationGrant[];
    onCreatorOffboarded?: unknown;
  } = {},
) {
  const stored = overrides.stored ?? [customRole(), adminRole];
  const roles = {
    list: vi.fn(async () => [...stored]),
    get: vi.fn(async (_: OrgContext, id: string) => stored.find((r) => r.id === id) ?? null),
    create: vi.fn(async () => 'created'),
    rename: vi.fn(async () => 'renamed'),
    setPermissions: vi.fn(async () => 'updated'),
    delete: vi.fn(async () => 'deleted'),
    ...overrides.roles,
  };
  const grants = {
    listOrganization: vi.fn(async () => [...(overrides.storedGrants ?? [grantOf('g1', 'role-1')])]),
    createOrganization: vi.fn(async () => 'created'),
    deleteOrganization: vi.fn(async () => ({ outcome: 'deleted', offboardedUserId: null })),
    changeRole: vi.fn(async () => 'updated'),
    suspendUser: vi.fn(async () => 'suspended'),
    reactivateUser: vi.fn(async () => 'reactivated'),
    countProtectedHolders: vi.fn(async () => 1),
    isProtectedHolder: vi.fn(async (_ctx: OrgContext, userId: string) => {
      const target = userOf();
      return (
        userId === target.id &&
        (overrides.storedGrants ?? []).some(
          (grant) =>
            stored.some((role) => role.id === grant.roleId && role.protectsLastHolder) &&
            (grant.subject.type === 'group' || grant.subject.value === target.email),
        )
      );
    }),
    ...overrides.grants,
  };
  const users = { get: vi.fn(async (): Promise<User | null> => userOf()), ...overrides.users };
  const providers = new Map<string, IdentityProvider>([
    ['corp', { id: 'corp' } as unknown as IdentityProvider],
  ]);
  const log = vi.fn();
  let next = 0;
  const admin = createAdministration({
    roles: roles as unknown as RoleRepository,
    grants: grants as unknown as GrantRepository,
    users: users as unknown as { get: () => Promise<User | null> },
    providers,
    clock: overrides.clock ?? fixedClock(NOW),
    ids: { ulid: () => ULIDS[next++] as string },
    log,
    ...(overrides.onCreatorOffboarded === undefined
      ? {}
      : {
          onCreatorOffboarded: overrides.onCreatorOffboarded as NonNullable<
            AdministrationDeps['onCreatorOffboarded']
          >,
        }),
  });
  return { admin, roles, grants, users, log };
}

const mutatingCalls = (grants: { [key: string]: unknown }, roles: { [key: string]: unknown }) =>
  [
    grants['createOrganization'],
    grants['deleteOrganization'],
    grants['changeRole'],
    grants['suspendUser'],
    grants['reactivateUser'],
    roles['create'],
    roles['rename'],
    roles['setPermissions'],
    roles['delete'],
  ] as ReturnType<typeof vi.fn>[];

describe('createRole', () => {
  const input = {
    key: 'release_manager',
    name: 'Release manager',
    scope: 'project' as const,
    permissions: ['project:read', 'project:packages:write'],
  };

  it('1: unknown permission and org permission on a project role are invalid_permission with details and no repository call', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.createRole(
        ctx,
        administrator,
        fenceFor(administrator),
        {
          ...input,
          permissions: ['project:nope'],
        },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'invalid_permission',
      details: ['Unknown permission: "project:nope"'],
    });
    expect(
      await admin.createRole(
        ctx,
        administrator,
        fenceFor(administrator),
        {
          ...input,
          permissions: ['org:read'],
        },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'invalid_permission',
      details: ['Organization permission in project role: "org:read"'],
    });
    expect(
      await admin.createRole(
        ctx,
        administrator,
        fenceFor(administrator),
        {
          ...input,
          permissions: ['project:read', 'project:read'],
        },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'invalid_permission',
      details: ['Duplicate permission: "project:read"'],
    });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('3: organization_admin and every default key are invalid_key', async () => {
    const { admin, roles } = setup();
    for (const { key } of DEFAULT_ROLES) {
      expect(
        await admin.createRole(
          ctx,
          administrator,
          fenceFor(administrator),
          { ...input, key },
          apiCall,
        ),
      ).toMatchObject({
        ok: false,
        error: 'invalid_key',
      });
    }
    expect(roles.create).not.toHaveBeenCalled();
  });

  it.each(['', 'Upper', '1abc', 'has-dash', 'has space', 'a'.repeat(65), 'ops\n'])(
    'rejects the malformed key %j',
    async (key) => {
      const { admin, roles } = setup();
      expect(
        await admin.createRole(
          ctx,
          administrator,
          fenceFor(administrator),
          { ...input, key },
          apiCall,
        ),
      ).toMatchObject({
        ok: false,
        error: 'invalid_key',
      });
      expect(roles.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    'x'.repeat(101),
    'tab\there',
    'new\nline',
    'nul\u0000',
    'zero\u200bwidth',
    'sep\u2028arator',
    'para\u2029graph',
    'lone\ud800surrogate',
  ])('rejects the name %j', async (name) => {
    const { admin, roles } = setup();
    expect(
      await admin.createRole(
        ctx,
        administrator,
        fenceFor(administrator),
        { ...input, name },
        apiCall,
      ),
    ).toMatchObject({
      ok: false,
      error: 'invalid_name',
    });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('accepts a name of 100 code points, counting an astral character once', async () => {
    const { admin } = setup();
    const name = (count: number) => '\u{1f600}'.repeat(count);
    expect(
      (
        await admin.createRole(
          ctx,
          administrator,
          fenceFor(administrator),
          {
            ...input,
            name: name(100),
          },
          apiCall,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await admin.createRole(
          ctx,
          administrator,
          fenceFor(administrator),
          {
            ...input,
            name: name(101),
          },
          apiCall,
        )
      ).ok,
    ).toBe(false);
  });

  it('creates the role with a server generated id and timestamp, returns it and logs', async () => {
    const { admin, roles, log } = setup();
    const result = await admin.createRole(
      ctx,
      administrator,
      fenceFor(administrator),
      input,
      apiCall,
    );
    expect(roles.create).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('admin-1'), {
      id: 'ID00',
      key: 'release_manager',
      name: 'Release manager',
      scope: 'project',
      permissions: ['project:read', 'project:packages:write'],
      now: NOW,
      opId: 'ID01',
      audit: expect.any(Object),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: 'ID00',
        key: 'release_manager',
        name: 'Release manager',
        scope: 'project',
        isSystem: false,
        protectsLastHolder: false,
        revision: 1,
        permissions: ['project:read', 'project:packages:write'],
      },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'role.changed',
      action: 'created',
      orgId: 'org-a',
      roleId: 'ID00',
      actorUserId: 'admin-1',
    });
  });

  it('generates a new id and a new timestamp for every call', async () => {
    let tick = 0;
    const clock: Clock = { now: () => new Date(Date.UTC(2026, 9, 15, 8, 0, tick++)) };
    const { admin, roles } = setup({ clock });
    await admin.createRole(ctx, administrator, fenceFor(administrator), input, apiCall);
    await admin.createRole(ctx, administrator, fenceFor(administrator), input, apiCall);
    const calls = (roles.create as ReturnType<typeof vi.fn>).mock.calls as unknown as [
      unknown,
      unknown,
      { id: string; now: string },
    ][];
    expect(calls.map(([, , call]) => call.id)).toEqual(['ID00', 'ID03']);
    expect(calls.map(([, , call]) => call.now)).toEqual([
      '2026-10-15T08:00:00.000Z',
      '2026-10-15T08:00:01.000Z',
    ]);
  });

  it('ignores a protectsLastHolder, id or now supplied by the caller', async () => {
    const { admin, roles } = setup();
    await admin.createRole(
      ctx,
      administrator,
      fenceFor(administrator),
      {
        ...input,
        protectsLastHolder: true,
        id: 'client-id',
        now: '1999-01-01T00:00:00.000Z',
      } as typeof input,
      apiCall,
    );
    expect(roles.create).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('admin-1'), {
      id: 'ID00',
      key: 'release_manager',
      name: 'Release manager',
      scope: 'project',
      permissions: ['project:read', 'project:packages:write'],
      now: NOW,
      opId: 'ID01',
      audit: expect.any(Object),
    });
  });

  it('maps the repository results one to one', async () => {
    const duplicate = setup({ roles: { create: vi.fn(async () => 'duplicate_key') } });
    expect(
      await duplicate.admin.createRole(ctx, administrator, fenceFor(administrator), input, apiCall),
    ).toEqual({
      ok: false,
      error: 'duplicate',
    });
    const invalid = setup({ roles: { create: vi.fn(async () => 'invalid_permissions') } });
    expect(
      await invalid.admin.createRole(ctx, administrator, fenceFor(administrator), input, apiCall),
    ).toEqual({
      ok: false,
      error: 'invalid_permission',
      details: ['The repository refused the permission list'],
    });
    expect(duplicate.log).not.toHaveBeenCalled();
    expect(invalid.log).not.toHaveBeenCalled();
  });

  it('refuses permissions that are not a list of strings', async () => {
    const { admin, roles } = setup();
    for (const permissions of ['org:read', null, [1], [{}]]) {
      expect(
        await admin.createRole(
          ctx,
          administrator,
          fenceFor(administrator),
          {
            ...input,
            permissions,
          } as unknown as typeof input,
          apiCall,
        ),
      ).toMatchObject({ ok: false, error: 'invalid_permission' });
    }
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('1c: a role above the actor permissions is forbidden, a subset is allowed', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.createRole(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        {
          ...input,
          permissions: ['project:read', 'project:packages:write'],
        },
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(roles.create).not.toHaveBeenCalled();
    expect(
      (
        await admin.createRole(
          ctx,
          rolesWriter,
          fenceFor(rolesWriter),
          {
            ...input,
            permissions: ['project:read'],
          },
          apiCall,
        )
      ).ok,
    ).toBe(true);
  });

  it('1a: an actor without org:roles:write is forbidden before any validation', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.createRole(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        {
          ...input,
          key: 'organization_admin',
        },
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(roles.create).not.toHaveBeenCalled();
  });
});

describe('listRoles', () => {
  it('returns the repository list', async () => {
    const { admin, roles } = setup();
    expect(await admin.listRoles(ctx)).toEqual([customRole(), adminRole]);
    expect(roles.list).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});

describe('renameRole', () => {
  it('renames with a server timestamp and logs', async () => {
    const { admin, roles, log } = setup();
    expect(
      await admin.renameRole(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        'role-1',
        'Operators',
        apiCall,
      ),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(roles.rename).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'role-1',
      name: 'Operators',
      now: NOW,
      opId: 'ID00',
      audit: expect.any(Object),
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'role.changed',
      action: 'renamed',
      orgId: 'org-a',
      roleId: 'role-1',
      actorUserId: 'actor-1',
    });
  });

  it('refuses an invalid name before the repository', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.renameRole(ctx, rolesWriter, fenceFor(rolesWriter), 'role-1', '', apiCall),
    ).toMatchObject({
      ok: false,
      error: 'invalid_name',
    });
    expect(
      await admin.renameRole(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        'role-1',
        'a\u0000b',
        apiCall,
      ),
    ).toMatchObject({
      ok: false,
      error: 'invalid_name',
    });
    expect(roles.rename).not.toHaveBeenCalled();
  });

  it('4: not_found and locked surface unchanged', async () => {
    const missing = setup({ roles: { rename: vi.fn(async () => 'not_found') } });
    expect(
      await missing.admin.renameRole(ctx, rolesWriter, fenceFor(rolesWriter), 'x', 'Name', apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    const locked = setup({ roles: { rename: vi.fn(async () => 'locked') } });
    expect(
      await locked.admin.renameRole(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        'role-1',
        'Name',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'locked',
    });
    expect(missing.log).not.toHaveBeenCalled();
    expect(locked.log).not.toHaveBeenCalled();
  });

  it('1a and 5: forbidden without org:roles:write; empty and non-string ids are not_found', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.renameRole(ctx, grantsWriter, fenceFor(grantsWriter), 'role-1', 'Name', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    for (const id of ['', 5, null]) {
      expect(
        await admin.renameRole(
          ctx,
          rolesWriter,
          fenceFor(rolesWriter),
          id as never,
          'Name',
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: 'not_found',
      });
    }
    expect(roles.rename).not.toHaveBeenCalled();
  });
});

describe('setRolePermissions', () => {
  const projectRole = customRole({ scope: 'project', permissions: ['project:read'] });

  it('validates against the stored role scope', async () => {
    const { admin, roles } = setup({ stored: [projectRole] });
    expect(
      await admin.setRolePermissions(
        ctx,
        administrator,
        fenceFor(administrator),
        'role-1',
        ['org:read'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'invalid_permission',
      details: ['Organization permission in project role: "org:read"'],
    });
    expect(
      await admin.setRolePermissions(
        ctx,
        administrator,
        fenceFor(administrator),
        'role-1',
        ['nope'],
        apiCall,
      ),
    ).toMatchObject({
      ok: false,
      error: 'invalid_permission',
    });
    expect(roles.setPermissions).not.toHaveBeenCalled();
  });

  it('updates an organization role and logs once', async () => {
    const { admin, roles, log } = setup();
    const result = await admin.setRolePermissions(
      ctx,
      rolesWriter,
      fenceFor(rolesWriter),
      'role-1',
      ['org:read'],
      apiCall,
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(roles.setPermissions).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'role-1',
      permissions: ['org:read'],
      now: NOW,
      opId: 'ID00',
      audit: expect.any(Object),
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: 'role.changed',
        action: 'permissions_set',
        roleId: 'role-1',
      }),
    );
  });

  it('1c: permissions above the actor are forbidden', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.setRolePermissions(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        'role-1',
        ['org:read', 'org:users:write'],
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(roles.setPermissions).not.toHaveBeenCalled();
  });

  it('5: a role that protects the last holder is locked before the permissions are validated', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.setRolePermissions(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        'role-admin',
        ['bogus'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'locked',
    });
    expect(roles.setPermissions).not.toHaveBeenCalled();
  });

  it('4: a missing role is not_found without a write; empty ids never reach the repository', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.setRolePermissions(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        'missing',
        ['org:read'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await admin.setRolePermissions(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        '',
        ['org:read'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(roles.get).toHaveBeenCalledTimes(1);
    expect(roles.setPermissions).not.toHaveBeenCalled();
  });

  it('4: repository locked, not_found and invalid_permissions map to their own errors', async () => {
    for (const [repo, expected] of [
      ['locked', { ok: false, error: 'locked' }],
      ['not_found', { ok: false, error: 'not_found' }],
      [
        'invalid_permissions',
        {
          ok: false,
          error: 'invalid_permission',
          details: ['The repository refused the permission list'],
        },
      ],
    ] as const) {
      const { admin, log } = setup({ roles: { setPermissions: vi.fn(async () => repo) } });
      expect(
        await admin.setRolePermissions(
          ctx,
          rolesWriter,
          fenceFor(rolesWriter),
          'role-1',
          ['org:read'],
          apiCall,
        ),
      ).toEqual(expected);
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('1a: forbidden without org:roles:write', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.setRolePermissions(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'role-1',
        ['org:read'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(roles.get).not.toHaveBeenCalled();
  });
});

describe('deleteRole', () => {
  it('deletes and logs', async () => {
    const { admin, roles, log } = setup();
    expect(
      await admin.deleteRole(ctx, rolesWriter, fenceFor(rolesWriter), 'role-1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(roles.delete).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'role-1',
      opId: 'ID00',
      audit: expect.any(Object),
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: 'role.changed', action: 'deleted', roleId: 'role-1' }),
    );
  });

  it('4: in_use, not_found and a system role surface as their own errors', async () => {
    for (const [repo, error] of [
      ['in_use', 'in_use'],
      ['not_found', 'not_found'],
      ['system', 'system_role'],
    ] as const) {
      const { admin, log } = setup({ roles: { delete: vi.fn(async () => repo) } });
      expect(
        await admin.deleteRole(ctx, rolesWriter, fenceFor(rolesWriter), 'role-1', apiCall),
      ).toEqual({
        ok: false,
        error,
      });
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('1a and 5: forbidden without org:roles:write; empty id is not_found', async () => {
    const { admin, roles } = setup();
    expect(
      await admin.deleteRole(ctx, grantsWriter, fenceFor(grantsWriter), 'role-1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await admin.deleteRole(ctx, rolesWriter, fenceFor(rolesWriter), '', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(roles.delete).not.toHaveBeenCalled();
  });
});

describe('grantOrganization', () => {
  const email = { type: 'email', value: 'Admin@Example.com' } as const;

  it('2: stores the e-mail normalized and logs without it', async () => {
    const { admin, grants, log } = setup();
    const result = await admin.grantOrganization(
      ctx,
      grantsWriter,
      fenceFor(grantsWriter),
      {
        subject: email,
        roleId: 'role-1',
      },
      apiCall,
    );
    expect(grants.createOrganization).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'ID00',
      subject: { type: 'email', value: 'admin@example.com' },
      roleId: 'role-1',
      createdBy: 'actor-1',
      now: NOW,
      opId: 'ID01',
      audit: expect.any(Object),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: 'ID00',
        subject: { type: 'email', value: 'admin@example.com' },
        roleId: 'role-1',
        createdBy: 'actor-1',
        createdAt: NOW,
        revision: 1,
      },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'grant.changed',
      action: 'granted',
      orgId: 'org-a',
      grantId: 'ID00',
      roleId: 'role-1',
      actorUserId: 'actor-1',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('example.com');
  });

  it.each([
    '',
    'not-an-email',
    'a@@b.com',
    'a b@example.com',
    'a@localhost',
    `${'a'.repeat(250)}@x.io`,
  ])('refuses the e-mail %j as invalid_subject', async (value) => {
    const { admin, grants } = setup();
    expect(
      await admin.grantOrganization(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        {
          subject: { type: 'email', value },
          roleId: 'role-1',
        },
        apiCall,
      ),
    ).toMatchObject({ ok: false, error: 'invalid_subject' });
    expect(grants.createOrganization).not.toHaveBeenCalled();
  });

  it('2: a group grant for a provider that is not configured is unknown_provider', async () => {
    const { admin, grants } = setup();
    for (const provider of ['other', 'local', 'CORP', '', '__proto__', 'constructor']) {
      expect(
        await admin.grantOrganization(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          {
            subject: { type: 'group', provider, value: 'admins' },
            roleId: 'role-1',
          },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'unknown_provider' });
    }
    expect(grants.createOrganization).not.toHaveBeenCalled();
  });

  it('accepts a group of a configured provider', async () => {
    const { admin, grants } = setup();
    const result = await admin.grantOrganization(
      ctx,
      grantsWriter,
      fenceFor(grantsWriter),
      {
        subject: { type: 'group', provider: 'corp', value: 'Platform Admins' },
        roleId: 'role-1',
      },
      apiCall,
    );
    expect(result.ok).toBe(true);
    expect(grants.createOrganization).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'ID00',
      subject: { type: 'group', provider: 'corp', value: 'Platform Admins' },
      roleId: 'role-1',
      createdBy: 'actor-1',
      now: NOW,
      opId: 'ID01',
      audit: expect.any(Object),
    });
  });

  it.each(['', ' admins', 'admins ', 'a'.repeat(257), 'ad\u0000mins', 'ad\u200bmins'])(
    'refuses the group name %j as invalid_subject',
    async (value) => {
      const { admin, grants } = setup();
      expect(
        await admin.grantOrganization(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          {
            subject: { type: 'group', provider: 'corp', value },
            roleId: 'role-1',
          },
          apiCall,
        ),
      ).toMatchObject({ ok: false, error: 'invalid_subject' });
      expect(grants.createOrganization).not.toHaveBeenCalled();
    },
  );

  it('accepts a group name of 256 code points', async () => {
    const { admin } = setup();
    const result = await admin.grantOrganization(
      ctx,
      grantsWriter,
      fenceFor(grantsWriter),
      {
        subject: { type: 'group', provider: 'corp', value: '\u{1f600}'.repeat(256) },
        roleId: 'role-1',
      },
      apiCall,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a subject of an unknown type or shape', async () => {
    const { admin, grants } = setup();
    for (const subject of [null, {}, { type: 'user', value: 'x' }, { type: 'email' }, 'a@b.io']) {
      expect(
        await admin.grantOrganization(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          {
            subject,
            roleId: 'role-1',
          } as never,
          apiCall,
        ),
      ).toMatchObject({ ok: false, error: 'invalid_subject' });
    }
    expect(grants.createOrganization).not.toHaveBeenCalled();
  });

  it('4: duplicate and role_scope_mismatch surface unchanged', async () => {
    for (const repo of ['duplicate', 'role_scope_mismatch'] as const) {
      const { admin, log } = setup({ grants: { createOrganization: vi.fn(async () => repo) } });
      expect(
        await admin.grantOrganization(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          {
            subject: email,
            roleId: 'role-1',
          },
          apiCall,
        ),
      ).toEqual({ ok: false, error: repo });
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('a missing, project-scoped or non-string role is role_scope_mismatch without a write', async () => {
    const { admin, grants } = setup({
      stored: [customRole({ id: 'role-p', scope: 'project', permissions: ['project:read'] })],
    });
    for (const roleId of ['nope', 'role-p', '', 7]) {
      expect(
        await admin.grantOrganization(
          ctx,
          administrator,
          fenceFor(administrator),
          {
            subject: email,
            roleId: roleId as never,
          },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'role_scope_mismatch' });
    }
    expect(grants.createOrganization).not.toHaveBeenCalled();
  });

  it('1b and 1c: only an organization admin grants a protected role or one above their permissions', async () => {
    const above = customRole({ id: 'role-big', permissions: ['org:read', 'org:users:write'] });
    const { admin, grants } = setup({ stored: [customRole(), adminRole, above] });
    for (const roleId of ['role-admin', 'role-big']) {
      expect(
        await admin.grantOrganization(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          {
            subject: email,
            roleId,
          },
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
    expect(grants.createOrganization).not.toHaveBeenCalled();
    for (const roleId of ['role-admin', 'role-big']) {
      expect(
        (
          await admin.grantOrganization(
            ctx,
            administrator,
            fenceFor(administrator),
            {
              subject: email,
              roleId,
            },
            apiCall,
          )
        ).ok,
      ).toBe(true);
    }
  });

  it('3: an actor who is not a user of the organization is forbidden, not a TypeError', async () => {
    const { admin, grants } = setup({ users: { get: vi.fn(async () => null) } });
    expect(
      await admin.grantOrganization(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        {
          subject: email,
          roleId: 'role-1',
        },
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(grants.createOrganization).not.toHaveBeenCalled();
  });

  it('1a: forbidden without org:grants:write', async () => {
    const { admin, grants } = setup();
    expect(
      await admin.grantOrganization(
        ctx,
        rolesWriter,
        fenceFor(rolesWriter),
        {
          subject: email,
          roleId: 'role-1',
        },
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(grants.createOrganization).not.toHaveBeenCalled();
  });
});

describe('grant changes and user status', () => {
  it('4: revoke surfaces last_holder and not_found unchanged and logs on success', async () => {
    const ok = setup();
    expect(
      await ok.admin.revokeOrganizationGrant(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'g1',
        apiCall,
      ),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(ok.grants.deleteOrganization).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'g1',
      opId: 'ID00',
      audit: expect.any(Object),
    });
    expect(ok.log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'grant.changed',
      action: 'revoked',
      orgId: 'org-a',
      grantId: 'g1',
      roleId: 'role-1',
      actorUserId: 'actor-1',
    });
    for (const repo of ['last_holder', 'not_found'] as const) {
      const { admin, log } = setup({ grants: { deleteOrganization: vi.fn(async () => repo) } });
      expect(
        await admin.revokeOrganizationGrant(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          'g1',
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: repo,
      });
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('an unknown grant id is not_found before the repository; empty ids too', async () => {
    const { admin, grants } = setup();
    expect(
      await admin.revokeOrganizationGrant(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'nope',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await admin.revokeOrganizationGrant(ctx, grantsWriter, fenceFor(grantsWriter), '', apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await admin.changeGrantRole(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'nope',
        'role-1',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(grants.deleteOrganization).not.toHaveBeenCalled();
    expect(grants.changeRole).not.toHaveBeenCalled();
  });

  it('1b: only an organization admin revokes a grant of a protected role', async () => {
    const { admin, grants } = setup({ storedGrants: [grantOf('g-admin', 'role-admin')] });
    expect(
      await admin.revokeOrganizationGrant(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'g-admin',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(grants.deleteOrganization).not.toHaveBeenCalled();
    expect(
      (
        await admin.revokeOrganizationGrant(
          ctx,
          administrator,
          fenceFor(administrator),
          'g-admin',
          apiCall,
        )
      ).ok,
    ).toBe(true);
  });

  it('4: changeGrantRole passes a server timestamp and surfaces every refusal', async () => {
    const stored = [customRole(), customRole({ id: 'role-2' }), adminRole];
    const ok = setup({ stored });
    expect(
      await ok.admin.changeGrantRole(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'g1',
        'role-2',
        apiCall,
      ),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(ok.grants.changeRole).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      id: 'g1',
      roleId: 'role-2',
      now: NOW,
      opId: 'ID00',
      audit: expect.any(Object),
    });
    expect(ok.log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'grant.changed',
      action: 'role_changed',
      orgId: 'org-a',
      grantId: 'g1',
      roleId: 'role-2',
      previousRoleId: 'role-1',
      actorUserId: 'actor-1',
    });
    for (const repo of ['not_found', 'last_holder', 'role_scope_mismatch'] as const) {
      const { admin, log } = setup({ stored, grants: { changeRole: vi.fn(async () => repo) } });
      expect(
        await admin.changeGrantRole(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          'g1',
          'role-2',
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: repo,
      });
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('a missing or project-scoped target role is role_scope_mismatch', async () => {
    const { admin, grants } = setup({
      stored: [customRole(), customRole({ id: 'role-p', scope: 'project', permissions: [] })],
    });
    for (const roleId of ['nope', 'role-p', '']) {
      expect(
        await admin.changeGrantRole(
          ctx,
          administrator,
          fenceFor(administrator),
          'g1',
          roleId,
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: 'role_scope_mismatch',
      });
    }
    expect(grants.changeRole).not.toHaveBeenCalled();
  });

  it('1b and 1c: a non-admin cannot change a grant to or from a protected role, or above their permissions', async () => {
    const above = customRole({ id: 'role-big', permissions: ['org:read', 'org:users:write'] });
    const stored = [customRole(), adminRole, above];
    const to = setup({ stored });
    expect(
      await to.admin.changeGrantRole(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'g1',
        'role-admin',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await to.admin.changeGrantRole(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'g1',
        'role-big',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(to.grants.changeRole).not.toHaveBeenCalled();
    const from = setup({ stored, storedGrants: [grantOf('g-admin', 'role-admin')] });
    expect(
      await from.admin.changeGrantRole(
        ctx,
        grantsWriter,
        fenceFor(grantsWriter),
        'g-admin',
        'role-1',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(from.grants.changeRole).not.toHaveBeenCalled();
    expect(
      (
        await to.admin.changeGrantRole(
          ctx,
          administrator,
          fenceFor(administrator),
          'g1',
          'role-big',
          apiCall,
        )
      ).ok,
    ).toBe(true);
  });

  it('1a: grant and user methods are forbidden without their permission', async () => {
    const { admin, grants, roles } = setup();
    expect(
      await admin.revokeOrganizationGrant(ctx, usersWriter, fenceFor(usersWriter), 'g1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.changeGrantRole(ctx, usersWriter, fenceFor(usersWriter), 'g1', 'role-1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.suspendUser(ctx, grantsWriter, fenceFor(grantsWriter), 'u1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.reactivateUser(ctx, grantsWriter, fenceFor(grantsWriter), 'u1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    for (const call of mutatingCalls(grants, roles)) expect(call).not.toHaveBeenCalled();
  });

  it('4: suspendUser surfaces last_holder and not_found', async () => {
    const ok = setup();
    expect(
      await ok.admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(ok.grants.suspendUser).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      userId: 'u1',
      now: NOW,
      audit: expect.any(Object),
    });
    for (const repo of ['last_holder', 'not_found'] as const) {
      const { admin, log } = setup({ grants: { suspendUser: vi.fn(async () => repo) } });
      expect(
        await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
      ).toEqual({
        ok: false,
        error: repo,
      });
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('5: an unknown user and an empty id are not_found before the repository', async () => {
    const { admin, grants } = setup({ users: { get: vi.fn(async () => null) } });
    expect(await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u9', apiCall)).toEqual(
      {
        ok: false,
        error: 'not_found',
      },
    );
    expect(await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), '', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await admin.reactivateUser(ctx, usersWriter, fenceFor(usersWriter), 'u9', apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(grants.suspendUser).not.toHaveBeenCalled();
    expect(grants.reactivateUser).not.toHaveBeenCalled();
  });

  it('reactivateUser answers ok without an event when nothing was suspended', async () => {
    const ok = setup({ users: { get: vi.fn(async () => userOf({ status: 'suspended' })) } });
    expect(
      await ok.admin.reactivateUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(ok.grants.reactivateUser).toHaveBeenCalledExactlyOnceWith(ctx, heldBy('actor-1'), {
      userId: 'u1',
      now: NOW,
      audit: expect.any(Object),
    });
    const none = setup({ grants: { reactivateUser: vi.fn(async () => 'unchanged') } });
    expect(
      await none.admin.reactivateUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(none.log).not.toHaveBeenCalled();
  });

  it('1b: only an organization admin touches a holder of a protected role', async () => {
    const byEmail = setup({
      storedGrants: [grantOf('g-admin', 'role-admin', 'target@example.com')],
    });
    expect(
      await byEmail.admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await byEmail.admin.reactivateUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(byEmail.grants.suspendUser).not.toHaveBeenCalled();
    expect(byEmail.grants.reactivateUser).not.toHaveBeenCalled();
    expect(
      (await byEmail.admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall))
        .ok,
    ).toBe(true);

    const byGroup = setup({
      storedGrants: [
        {
          ...grantOf('g-group', 'role-admin'),
          subject: { type: 'group', provider: 'corp', value: 'admins' },
        },
      ],
    });
    expect(
      await byGroup.admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(byGroup.grants.suspendUser).not.toHaveBeenCalled();
  });

  it('a non-admin may suspend a user who holds no protected role grant', async () => {
    const { admin } = setup({
      storedGrants: [
        grantOf('g-admin', 'role-admin', 'other@example.com'),
        grantOf('g1', 'role-1'),
      ],
    });
    expect(
      (await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall)).ok,
    ).toBe(true);
  });

  it('5: suspending an already suspended user logs nothing; a fresh suspension and a reactivation log', async () => {
    const already = setup({
      users: { get: vi.fn(async () => userOf({ status: 'suspended' })) },
      grants: { suspendUser: vi.fn(async () => 'unchanged') },
    });
    expect(
      await already.admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(already.log).not.toHaveBeenCalled();

    const { admin, log } = setup();
    await admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall);
    await admin.reactivateUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall);
    expect(log.mock.calls.map(([entry]) => entry)).toEqual([
      {
        level: 'info',
        event: 'user.changed',
        action: 'suspended',
        orgId: 'org-a',
        userId: 'u1',
        actorUserId: 'admin-1',
      },
      {
        level: 'info',
        event: 'user.changed',
        action: 'reactivated',
        orgId: 'org-a',
        userId: 'u1',
        actorUserId: 'admin-1',
      },
    ]);
  });
});

describe('1b: a non-admin holding every permission still cannot touch a protected role', () => {
  const powerful: ActorContext = {
    kind: 'organization',
    userId: 'actor-2',
    permissions: new Set(ALL),
    isOrganizationAdmin: false,
  };
  const email = { type: 'email', value: 'me@example.com' } as const;

  it('refuses grant, change to, change from and revoke', async () => {
    const { admin, grants } = setup({
      storedGrants: [grantOf('g1', 'role-1'), grantOf('g-admin', 'role-admin')],
    });
    expect(
      await admin.grantOrganization(
        ctx,
        powerful,
        fenceFor(powerful),
        {
          subject: email,
          roleId: 'role-admin',
        },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.changeGrantRole(ctx, powerful, fenceFor(powerful), 'g1', 'role-admin', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.changeGrantRole(ctx, powerful, fenceFor(powerful), 'g-admin', 'role-1', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.revokeOrganizationGrant(ctx, powerful, fenceFor(powerful), 'g-admin', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(grants.createOrganization).not.toHaveBeenCalled();
    expect(grants.changeRole).not.toHaveBeenCalled();
    expect(grants.deleteOrganization).not.toHaveBeenCalled();
  });
});

describe('superior targets: a non-admin cannot act on a role or grant above their permissions', () => {
  const superior = customRole({ id: 'role-sup', permissions: ['org:read', 'org:users:write'] });
  const stored = [customRole(), superior, adminRole];
  const grantsActor = actorWith('org:grants:write', 'org:read');
  const rolesActor = actorWith('org:roles:write', 'org:read');

  it('setRolePermissions: stripping a permission the actor lacks is forbidden', async () => {
    const { admin, roles, log } = setup({ stored });
    expect(
      await admin.setRolePermissions(
        ctx,
        rolesActor,
        fenceFor(rolesActor),
        'role-sup',
        ['org:read'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(roles.setPermissions).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'admin.denied',
      action: 'permissions_set',
      orgId: 'org-a',
      actorUserId: 'actor-1',
    });
    expect(
      (
        await admin.setRolePermissions(
          ctx,
          administrator,
          fenceFor(administrator),
          'role-sup',
          ['org:read'],
          apiCall,
        )
      ).ok,
    ).toBe(true);
  });

  it('renameRole and deleteRole: forbidden on a superior role, allowed on a lower one', async () => {
    const { admin, roles } = setup({ stored });
    expect(
      await admin.renameRole(ctx, rolesActor, fenceFor(rolesActor), 'role-sup', 'Renamed', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.deleteRole(ctx, rolesActor, fenceFor(rolesActor), 'role-sup', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(roles.rename).not.toHaveBeenCalled();
    expect(roles.delete).not.toHaveBeenCalled();
    expect(
      (await admin.renameRole(ctx, rolesActor, fenceFor(rolesActor), 'role-1', 'Renamed', apiCall))
        .ok,
    ).toBe(true);
    expect(
      (await admin.deleteRole(ctx, rolesActor, fenceFor(rolesActor), 'role-1', apiCall)).ok,
    ).toBe(true);
    expect(
      (await admin.deleteRole(ctx, administrator, fenceFor(administrator), 'role-sup', apiCall)).ok,
    ).toBe(true);
  });

  it('renameRole and deleteRole: a missing role is not_found for a non-admin', async () => {
    const { admin, roles } = setup({ stored });
    expect(
      await admin.renameRole(ctx, rolesActor, fenceFor(rolesActor), 'nope', 'Renamed', apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await admin.deleteRole(ctx, rolesActor, fenceFor(rolesActor), 'nope', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(roles.rename).not.toHaveBeenCalled();
    expect(roles.delete).not.toHaveBeenCalled();
  });

  it('revokeOrganizationGrant: forbidden for a missing role; a superior grant role is revocable', async () => {
    const { admin, grants } = setup({
      stored,
      storedGrants: [grantOf('g-sup', 'role-sup'), grantOf('g-gone', 'role-gone')],
    });
    expect(
      await admin.revokeOrganizationGrant(
        ctx,
        grantsActor,
        fenceFor(grantsActor),
        'g-gone',
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(grants.deleteOrganization).not.toHaveBeenCalled();
    expect(
      await admin.revokeOrganizationGrant(
        ctx,
        grantsActor,
        fenceFor(grantsActor),
        'g-sup',
        apiCall,
      ),
    ).toEqual({ ok: true, value: null });
    expect(grants.deleteOrganization).toHaveBeenCalledOnce();
    expect(
      (
        await admin.revokeOrganizationGrant(
          ctx,
          administrator,
          fenceFor(administrator),
          'g-gone',
          apiCall,
        )
      ).ok,
    ).toBe(true);
  });

  it('changeGrantRole: forbidden when the current role is superior or missing', async () => {
    const { admin, grants } = setup({
      stored,
      storedGrants: [grantOf('g-sup', 'role-sup'), grantOf('g-gone', 'role-gone')],
    });
    for (const id of ['g-sup', 'g-gone']) {
      expect(
        await admin.changeGrantRole(ctx, grantsActor, fenceFor(grantsActor), id, 'role-1', apiCall),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
    expect(grants.changeRole).not.toHaveBeenCalled();
    expect(
      (
        await admin.changeGrantRole(
          ctx,
          administrator,
          fenceFor(administrator),
          'g-sup',
          'role-1',
          apiCall,
        )
      ).ok,
    ).toBe(true);
  });
});

describe('the actor is validated and the admin flag must be exactly true', () => {
  it('a string flag does not make an actor an administrator', async () => {
    for (const flag of ['false', 'true', 1, 'yes', {}]) {
      const actor = {
        kind: 'organization',
        userId: 'actor-3',
        permissions: new Set(ALL),
        isOrganizationAdmin: flag,
      } as unknown as ActorContext;
      const { admin, grants } = setup({ storedGrants: [grantOf('g1', 'role-1')] });
      expect(
        await admin.changeGrantRole(ctx, actor, fenceFor(actor), 'g1', 'role-admin', apiCall),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(
        await admin.grantOrganization(
          ctx,
          actor,
          fenceFor(actor),
          {
            subject: { type: 'email', value: 'me@example.com' },
            roleId: 'role-admin',
          },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'forbidden' });
      expect(grants.changeRole).not.toHaveBeenCalled();
      expect(grants.createOrganization).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'admin'],
    [
      'permissions as an array',
      {
        kind: 'organization',
        userId: 'a',
        permissions: ['org:roles:write'],
        isOrganizationAdmin: true,
      },
    ],
    ['permissions missing', { kind: 'organization', userId: 'a', isOrganizationAdmin: true }],
    [
      'an empty user id',
      { kind: 'organization', userId: '', permissions: new Set(ALL), isOrganizationAdmin: true },
    ],
    [
      'a numeric user id',
      { kind: 'organization', userId: 7, permissions: new Set(ALL), isOrganizationAdmin: true },
    ],
  ])('%s is forbidden everywhere and nothing is written', async (_name, actor) => {
    const { admin, grants, roles, log } = setup();
    const bad = actor as unknown as ActorContext;
    const input = { key: 'ops_two', name: 'Ops', scope: 'organization' as const, permissions: [] };
    const results = await Promise.all([
      admin.createRole(ctx, bad, fenceFor(bad), input, apiCall),
      admin.renameRole(ctx, bad, fenceFor(bad), 'role-1', 'Name', apiCall),
      admin.setRolePermissions(ctx, bad, fenceFor(bad), 'role-1', [], apiCall),
      admin.deleteRole(ctx, bad, fenceFor(bad), 'role-1', apiCall),
      admin.grantOrganization(
        ctx,
        bad,
        fenceFor(bad),
        {
          subject: { type: 'email', value: 'me@example.com' },
          roleId: 'role-1',
        },
        apiCall,
      ),
      admin.revokeOrganizationGrant(ctx, bad, fenceFor(bad), 'g1', apiCall),
      admin.changeGrantRole(ctx, bad, fenceFor(bad), 'g1', 'role-1', apiCall),
      admin.suspendUser(ctx, bad, fenceFor(bad), 'u1', apiCall),
      admin.reactivateUser(ctx, bad, fenceFor(bad), 'u1', apiCall),
    ]);
    for (const result of results) expect(result).toEqual({ ok: false, error: 'forbidden' });
    for (const call of mutatingCalls(grants, roles)) expect(call).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(9);
    for (const [entry] of log.mock.calls) {
      expect(entry).toMatchObject({ event: 'admin.denied', orgId: 'org-a' });
    }
  });
});

describe('admin.denied for an invalid actor', () => {
  it('never logs a caller-supplied user id when the actor does not validate', async () => {
    const { admin, log } = setup();
    const bad = {
      kind: 'organization',
      userId: 'someone@example.com',
      permissions: ['org:roles:write'],
      isOrganizationAdmin: true,
    } as unknown as ActorContext;
    expect(await admin.deleteRole(ctx, bad, fenceFor(bad), 'role-1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'admin.denied',
      action: 'deleted',
      orgId: 'org-a',
      actorUserId: null,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('example.com');
  });
});

describe('admin.denied', () => {
  it('is logged for every forbidden refusal with action, org and actor only', async () => {
    const { admin, log } = setup({
      storedGrants: [grantOf('g-admin', 'role-admin', 'target@example.com')],
    });
    await admin.createRole(
      ctx,
      grantsWriter,
      fenceFor(grantsWriter),
      {
        key: 'ops_two',
        name: 'Ops',
        scope: 'organization',
        permissions: [],
      },
      apiCall,
    );
    await admin.grantOrganization(
      ctx,
      grantsWriter,
      fenceFor(grantsWriter),
      {
        subject: { type: 'email', value: 'me@example.com' },
        roleId: 'role-admin',
      },
      apiCall,
    );
    await admin.revokeOrganizationGrant(
      ctx,
      grantsWriter,
      fenceFor(grantsWriter),
      'g-admin',
      apiCall,
    );
    await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall);
    expect(log.mock.calls.map(([entry]) => entry)).toEqual([
      {
        level: 'info',
        event: 'admin.denied',
        action: 'created',
        orgId: 'org-a',
        actorUserId: 'actor-1',
      },
      {
        level: 'info',
        event: 'admin.denied',
        action: 'granted',
        orgId: 'org-a',
        actorUserId: 'actor-1',
      },
      {
        level: 'info',
        event: 'admin.denied',
        action: 'revoked',
        orgId: 'org-a',
        actorUserId: 'actor-1',
      },
      {
        level: 'info',
        event: 'admin.denied',
        action: 'suspended',
        orgId: 'org-a',
        actorUserId: 'actor-1',
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('example.com');
  });
});

describe('privilege escalation by a user with only org:grants:write', () => {
  it('cannot promote themself to organization_admin or suspend the administrator', async () => {
    const attacker = actorWith('org:grants:write');
    const { admin, grants, roles } = setup({
      storedGrants: [
        grantOf('g-admin', 'role-admin', 'target@example.com'),
        grantOf('g-me', 'role-1', 'me@example.com'),
      ],
    });
    const self = { type: 'email', value: 'me@example.com' } as const;

    expect(
      await admin.grantOrganization(
        ctx,
        attacker,
        fenceFor(attacker),
        {
          subject: self,
          roleId: 'role-admin',
        },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.changeGrantRole(ctx, attacker, fenceFor(attacker), 'g-me', 'role-admin', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.revokeOrganizationGrant(ctx, attacker, fenceFor(attacker), 'g-admin', apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await admin.suspendUser(ctx, attacker, fenceFor(attacker), 'u1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.setRolePermissions(ctx, attacker, fenceFor(attacker), 'role-1', ALL, apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await admin.createRole(
        ctx,
        attacker,
        fenceFor(attacker),
        {
          key: 'sneaky',
          name: 'Sneaky',
          scope: 'organization',
          permissions: ALL,
        },
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    for (const call of mutatingCalls(grants, roles)) expect(call).not.toHaveBeenCalled();
  });

  it('even with org:users:write cannot suspend the administrator', async () => {
    const attacker = actorWith('org:grants:write', 'org:users:write');
    const { admin, grants } = setup({
      storedGrants: [grantOf('g-admin', 'role-admin', 'target@example.com')],
    });
    expect(await admin.suspendUser(ctx, attacker, fenceFor(attacker), 'u1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(grants.suspendUser).not.toHaveBeenCalled();
  });
});

describe('logging', () => {
  it('a throwing log sink does not turn a stored change into a failure', async () => {
    const { admin, log } = setup();
    log.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(
      await admin.deleteRole(ctx, rolesWriter, fenceFor(rolesWriter), 'role-1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe('repository contract: invalid input is answered, never thrown', () => {
  const NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const PROVIDER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const count = (value: string) => Array.from(value).length;

  function strictRepositories() {
    const stored = customRole();
    const roles = {
      list: async () => [stored],
      get: async () => stored,
      create: async (
        _: OrgContext,
        _fence: unknown,
        input: { key: string; name: string; now: string },
      ) => {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.key)) throw new TypeError('key');
        if (NAME.test(input.name) || count(input.name) < 1 || count(input.name) > 100) {
          throw new TypeError('name');
        }
        if (!TIMESTAMP.test(input.now)) throw new TypeError('now');
        return 'created';
      },
      rename: async (
        _: OrgContext,
        _fence: unknown,
        { name, now }: Parameters<RoleRepository['rename']>[2],
      ) => {
        if (NAME.test(name) || count(name) < 1 || count(name) > 100) throw new TypeError('name');
        if (!TIMESTAMP.test(now)) throw new TypeError('now');
        return 'renamed';
      },
      setPermissions: async () => 'updated',
      delete: async () => 'deleted',
    };
    const grants = {
      listOrganization: async () => [],
      createOrganization: async (
        _: OrgContext,
        _fence: unknown,
        input: {
          subject: { type: string; value: string; provider?: string };
          now: string;
        },
      ) => {
        const { subject } = input;
        if (subject.type === 'email') {
          if (normalizeEmail(subject.value) !== subject.value) throw new TypeError('email');
        } else {
          if (!PROVIDER.test(subject.provider ?? '')) throw new TypeError('provider');
          const value = subject.value;
          if (
            count(value) < 1 ||
            count(value) > 256 ||
            value !== value.trim() ||
            /[\p{Cc}\p{Cf}]/u.test(value)
          ) {
            throw new TypeError('group');
          }
        }
        if (!TIMESTAMP.test(input.now)) throw new TypeError('now');
        return 'created';
      },
      deleteOrganization: async () => ({ outcome: 'deleted', offboardedUserId: null }),
      changeRole: async () => 'updated',
      suspendUser: async () => 'suspended',
      reactivateUser: async () => 'reactivated',
      countProtectedHolders: async () => 1,
    };
    return setup({ roles, grants });
  }

  const names = [
    'ok',
    'line\u2028separator',
    'para\u2029separator',
    '\u{1f600}'.repeat(100),
    '\u{1f600}'.repeat(101),
    'a'.repeat(100),
    'a'.repeat(101),
    '',
    '\u0085next-line',
    '\ufeffbom',
    'lone\udc00low',
  ];

  it.each(names)('createRole and renameRole with the name %j', async (name) => {
    const { admin } = strictRepositories();
    const valid = count(name) >= 1 && count(name) <= 100 && !NAME.test(name);
    const created = await admin.createRole(
      ctx,
      administrator,
      fenceFor(administrator),
      {
        key: 'ops_two',
        name,
        scope: 'organization',
        permissions: ['org:read'],
      },
      apiCall,
    );
    const renamed = await admin.renameRole(
      ctx,
      administrator,
      fenceFor(administrator),
      'role-1',
      name,
      apiCall,
    );
    expect(created.ok).toBe(valid);
    expect(renamed.ok).toBe(valid);
    if (!created.ok) expect(created.error).toBe('invalid_name');
    if (!renamed.ok) expect(renamed.error).toBe('invalid_name');
  });

  const emails: readonly (readonly [string, string | null])[] = [
    ['Admin@Example.com', 'admin@example.com'],
    ['  Admin@Example.com  ', 'admin@example.com'],
    ['ADMIN@EXAMPLE.COM', 'admin@example.com'],
    ['admin@example.com', 'admin@example.com'],
    ['a\u2028b@example.com', null],
    ['admin@example.com\u200b', null],
    ['bad', null],
  ];

  it.each(emails)('grantOrganization with the e-mail %j', async (value, stored) => {
    const { admin } = strictRepositories();
    const result = await admin.grantOrganization(
      ctx,
      administrator,
      fenceFor(administrator),
      {
        subject: { type: 'email', value },
        roleId: 'role-1',
      },
      apiCall,
    );
    expect(result.ok).toBe(stored !== null);
    if (result.ok) {
      expect(result.value.subject).toEqual({ type: 'email', value: stored });
    } else {
      expect(result.error).toBe('invalid_subject');
    }
  });

  const groups: readonly (readonly [string, boolean])[] = [
    ['ops', true],
    ['\u{1f600}'.repeat(256), true],
    ['\u{1f600}'.repeat(257), false],
    ['x'.repeat(256), true],
    ['x'.repeat(257), false],
    [' padded', false],
    ['zero\u200bwidth', false],
    ['line\u2028separator', true],
    ['', false],
  ];

  it.each(groups)('grantOrganization with the group %j', async (value, acceptable) => {
    const { admin } = strictRepositories();
    const result = await admin.grantOrganization(
      ctx,
      administrator,
      fenceFor(administrator),
      {
        subject: { type: 'group', provider: 'corp', value },
        roleId: 'role-1',
      },
      apiCall,
    );
    expect(result.ok).toBe(acceptable);
    if (!result.ok) expect(result.error).toBe('invalid_subject');
  });
});

describe('creator offboarding', () => {
  it('reports a fresh suspension once with cause suspended', async () => {
    const onCreatorOffboarded = vi.fn(async () => undefined);
    const { admin } = setup({ onCreatorOffboarded });
    expect(
      await admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(onCreatorOffboarded).toHaveBeenCalledExactlyOnceWith(ctx, {
      userId: 'u1',
      cause: 'suspended',
    });
  });

  it('does not report an already suspended user or a refused suspension', async () => {
    const onCreatorOffboarded = vi.fn(async () => undefined);
    const already = setup({
      grants: { suspendUser: vi.fn(async () => 'unchanged') },
      onCreatorOffboarded,
    });
    expect(
      (await already.admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall))
        .ok,
    ).toBe(true);
    for (const repo of ['authority', 'conflict', 'indeterminate', 'last_holder', 'not_found']) {
      const refused = setup({
        grants: { suspendUser: vi.fn(async () => repo) },
        onCreatorOffboarded,
      });
      expect(
        (
          await refused.admin.suspendUser(
            ctx,
            administrator,
            fenceFor(administrator),
            'u1',
            apiCall,
          )
        ).ok,
      ).toBe(false);
    }
    const denied = setup({ onCreatorOffboarded });
    await denied.admin.suspendUser(ctx, grantsWriter, fenceFor(grantsWriter), 'u1', apiCall);
    expect(onCreatorOffboarded).not.toHaveBeenCalled();
  });

  it('keeps the suspension ok and logs the failure by name when the callback rejects', async () => {
    const onCreatorOffboarded = vi.fn(async () => {
      throw new RangeError('secret-bearing detail');
    });
    const { admin, log } = setup({ onCreatorOffboarded });
    expect(
      await admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    const failures = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'user.offboarding_callback_failed');
    expect(failures).toEqual([
      {
        level: 'warn',
        event: 'user.offboarding_callback_failed',
        orgId: 'org-a',
        userId: 'u1',
        cause: 'suspended',
        error: 'RangeError',
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-bearing detail');
  });

  it('keeps the suspension ok when the callback throws synchronously and the log sink fails', async () => {
    const onCreatorOffboarded = vi.fn(() => {
      throw new Error('boom');
    });
    const { admin } = setup({
      onCreatorOffboarded,
    });
    expect(
      (await admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall)).ok,
    ).toBe(true);
    const failingLog = createAdministration({
      roles: {
        list: async () => [],
        get: async () => null,
      } as unknown as AdministrationDeps['roles'],
      grants: {
        listOrganization: async () => [],
        suspendUser: async () => 'suspended',
      } as unknown as AdministrationDeps['grants'],
      users: { get: async () => userOf() },
      providers: new Map(),
      clock: fixedClock(NOW),
      ids: { ulid: () => 'ID00' },
      log: () => {
        throw new Error('sink down');
      },
      onCreatorOffboarded,
    });
    expect(
      await failingLog.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe('creator offboarding on organization grant revoke', () => {
  const revoked = (offboardedUserId: string | null) => ({
    deleteOrganization: vi.fn(async () => ({ outcome: 'deleted', offboardedUserId })),
  });

  it('reports the user whose last organization grant was revoked once with cause membership_removed', async () => {
    const onCreatorOffboarded = vi.fn(async () => undefined);
    const { admin, log } = setup({ grants: revoked('u1'), onCreatorOffboarded });
    expect(
      await admin.revokeOrganizationGrant(ctx, grantsWriter, fenceFor(grantsWriter), 'g1', apiCall),
    ).toEqual({ ok: true, value: null });
    expect(onCreatorOffboarded).toHaveBeenCalledExactlyOnceWith(ctx, {
      userId: 'u1',
      cause: 'membership_removed',
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: 'grant.changed', action: 'revoked', grantId: 'g1' }),
    );
  });

  it('does not report a revoke that leaves no offboarded user', async () => {
    const onCreatorOffboarded = vi.fn(async () => undefined);
    const { admin } = setup({ grants: revoked(null), onCreatorOffboarded });
    expect(
      (
        await admin.revokeOrganizationGrant(
          ctx,
          grantsWriter,
          fenceFor(grantsWriter),
          'g1',
          apiCall,
        )
      ).ok,
    ).toBe(true);
    expect(onCreatorOffboarded).not.toHaveBeenCalled();
  });

  it('does not report a refused revoke', async () => {
    const onCreatorOffboarded = vi.fn(async () => undefined);
    for (const repo of ['authority', 'conflict', 'indeterminate', 'last_holder', 'not_found']) {
      const { admin } = setup({
        grants: { deleteOrganization: vi.fn(async () => repo) },
        onCreatorOffboarded,
      });
      expect(
        (
          await admin.revokeOrganizationGrant(
            ctx,
            grantsWriter,
            fenceFor(grantsWriter),
            'g1',
            apiCall,
          )
        ).ok,
      ).toBe(false);
    }
    expect(onCreatorOffboarded).not.toHaveBeenCalled();
  });

  it('revokes without a callback configured', async () => {
    const { admin } = setup({ grants: revoked('u1') });
    expect(
      await admin.revokeOrganizationGrant(ctx, grantsWriter, fenceFor(grantsWriter), 'g1', apiCall),
    ).toEqual({ ok: true, value: null });
  });

  it('keeps the revoke ok and logs the failure by name when the callback throws', async () => {
    const onCreatorOffboarded = vi.fn(async () => {
      throw new RangeError('secret-bearing detail');
    });
    const { admin, log } = setup({ grants: revoked('u1'), onCreatorOffboarded });
    expect(
      await admin.revokeOrganizationGrant(ctx, grantsWriter, fenceFor(grantsWriter), 'g1', apiCall),
    ).toEqual({ ok: true, value: null });
    const failures = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'user.offboarding_callback_failed');
    expect(failures).toEqual([
      {
        level: 'warn',
        event: 'user.offboarding_callback_failed',
        orgId: 'org-a',
        userId: 'u1',
        cause: 'membership_removed',
        error: 'RangeError',
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-bearing detail');
  });
});

describe('repository holder checks and retired permissions', () => {
  it('allows a project manager to suspend a non-holder while a protected group grant exists', async () => {
    const { admin, grants } = setup({
      storedGrants: [
        {
          ...grantOf('group', 'role-admin'),
          subject: { type: 'group', provider: 'corp', value: 'admins' },
        },
      ],
      grants: { isProtectedHolder: vi.fn(async () => false) },
    });
    expect(await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall)).toEqual(
      {
        ok: true,
        value: null,
      },
    );
    expect(grants.isProtectedHolder).toHaveBeenCalledExactlyOnceWith(ctx, 'u1');
  });

  it('refuses a project manager touching the last protected holder reported by the repository', async () => {
    const { admin, grants } = setup({ grants: { isProtectedHolder: vi.fn(async () => true) } });
    expect(await admin.suspendUser(ctx, usersWriter, fenceFor(usersWriter), 'u1', apiCall)).toEqual(
      {
        ok: false,
        error: 'forbidden',
      },
    );
    expect(grants.suspendUser).not.toHaveBeenCalled();
  });

  it('allows renaming a role with retired permissions covered in the current catalogue', async () => {
    const { admin } = setup({
      stored: [customRole({ permissions: ['org:read', 'retired:permission'] })],
    });
    expect(
      await admin.renameRole(ctx, rolesWriter, fenceFor(rolesWriter), 'role-1', 'Renamed', apiCall),
    ).toEqual({ ok: true, value: null });
  });
});

const apiCall: ApiCall = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};

const auditCases = [
  {
    method: 'createRole',
    store: 'create',
    action: 'role.create',
    type: 'role',
    id: 'ID00',
    changes: {
      key: { new: 'ops2' },
      name: { new: 'Operators' },
      scope: { new: 'organization' },
      permissions: { new: ['org:read'] },
    },
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.createRole(
        ctx,
        administrator,
        fenceFor(administrator),
        { key: 'ops2', name: 'Operators', scope: 'organization', permissions: ['org:read'] },
        call,
      ),
  },
  {
    method: 'renameRole',
    store: 'rename',
    action: 'role.rename',
    type: 'role',
    id: 'role-1',
    changes: { name: { new: 'Operators' } },
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.renameRole(ctx, administrator, fenceFor(administrator), 'role-1', 'Operators', call),
  },
  {
    method: 'setRolePermissions',
    store: 'setPermissions',
    action: 'role.permissions_set',
    type: 'role',
    id: 'role-1',
    changes: { permissions: { new: ['org:read'] } },
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.setRolePermissions(
        ctx,
        administrator,
        fenceFor(administrator),
        'role-1',
        ['org:read'],
        call,
      ),
  },
  {
    method: 'deleteRole',
    store: 'delete',
    action: 'role.delete',
    type: 'role',
    id: 'role-1',
    changes: undefined,
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.deleteRole(ctx, administrator, fenceFor(administrator), 'role-1', call),
  },
  {
    method: 'grantOrganization',
    store: 'createOrganization',
    action: 'grant.create',
    type: 'grant',
    id: 'ID00',
    changes: { subject_kind: { new: 'email' }, role_id: { new: 'role-1' } },
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.grantOrganization(
        ctx,
        administrator,
        fenceFor(administrator),
        { subject: { type: 'email', value: 'someone@example.com' }, roleId: 'role-1' },
        call,
      ),
  },
  {
    method: 'revokeOrganizationGrant',
    store: 'deleteOrganization',
    action: 'grant.revoke',
    type: 'grant',
    id: 'g1',
    changes: undefined,
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.revokeOrganizationGrant(ctx, administrator, fenceFor(administrator), 'g1', call),
  },
  {
    method: 'changeGrantRole',
    store: 'changeRole',
    action: 'grant.role_change',
    type: 'grant',
    id: 'g1',
    changes: { role_id: { new: 'role-1' } },
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.changeGrantRole(ctx, administrator, fenceFor(administrator), 'g1', 'role-1', call),
  },
  {
    method: 'suspendUser',
    store: 'suspendUser',
    action: 'user.suspend',
    type: 'user',
    id: 'u1',
    changes: undefined,
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.suspendUser(ctx, administrator, fenceFor(administrator), 'u1', call),
  },
  {
    method: 'reactivateUser',
    store: 'reactivateUser',
    action: 'user.reactivate',
    type: 'user',
    id: 'u1',
    changes: undefined,
    run: (admin: ReturnType<typeof setup>['admin'], call: ApiCall) =>
      admin.reactivateUser(ctx, administrator, fenceFor(administrator), 'u1', call),
  },
] as const;

function storeInput(
  stores: ReturnType<typeof setup>,
  method: string,
): { audit: AuditEvent; idempotency?: IdempotencyRecord; opId?: string } {
  const mock = { ...stores.roles, ...stores.grants }[method as 'create'] as ReturnType<
    typeof vi.fn
  >;
  expect(mock).toHaveBeenCalledTimes(1);
  return (mock.mock.calls[0] as unknown[])[2] as {
    audit: AuditEvent;
    idempotency?: IdempotencyRecord;
    opId?: string;
  };
}

describe('administration audit and idempotency', () => {
  describe.each([
    { kind: 'overlong', id: 'a'.repeat(201) },
    { kind: 'credential-shaped', id: ['password', 'example'].join('=') },
    { kind: 'rewritten by audit sanitization', id: 'https://example.com/path?query=value' },
  ])('audit-incompatible $kind target id', ({ id }) => {
    describe.each([
      { kind: 'admin', actor: administrator },
      { kind: 'non-admin', actor: actorWith(...ALL) },
    ])('$kind actor', ({ actor }) => {
      it.each([
        'renameRole',
        'setRolePermissions',
        'deleteRole',
        'revokeOrganizationGrant',
        'changeGrantRole',
        'suspendUser',
        'reactivateUser',
      ] as const)('%s returns not_found before store calls', async (method) => {
        const { admin, roles, grants, users, log } = setup({
          stored: [customRole({ id }), customRole(), adminRole],
          storedGrants: [grantOf(id, 'role-1')],
          users: { get: vi.fn(async () => userOf({ id })) },
        });
        const fence = fenceFor(actor);
        let result;
        switch (method) {
          case 'renameRole':
            result = await admin.renameRole(ctx, actor, fence, id, 'Operators', apiCall);
            break;
          case 'setRolePermissions':
            result = await admin.setRolePermissions(ctx, actor, fence, id, ['org:read'], apiCall);
            break;
          case 'changeGrantRole':
            result = await admin.changeGrantRole(ctx, actor, fence, id, 'role-1', apiCall);
            break;
          default:
            result = await admin[method](ctx, actor, fence, id, apiCall);
        }
        expect(result).toEqual({ ok: false, error: 'not_found' });
        for (const store of [roles, grants, users]) {
          for (const mock of Object.values(store)) expect(mock).not.toHaveBeenCalled();
        }
        expect(log).not.toHaveBeenCalled();
      });
    });
  });

  it('createRole returns invalid_name without store calls when audit refuses the name', async () => {
    const { admin, roles, grants, users, log } = setup();
    const result = await admin.createRole(
      ctx,
      rolesWriter,
      fenceFor(rolesWriter),
      {
        key: 'operators',
        name: ['password', 'example'].join('='),
        scope: 'organization',
        permissions: ['org:read'],
      },
      apiCall,
    );
    expect(result).toEqual({ ok: false, error: 'invalid_name' });
    for (const store of [roles, grants, users]) {
      for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('renameRole returns invalid_name without store calls when audit refuses the name', async () => {
    const { admin, roles, grants, users, log } = setup();
    const result = await admin.renameRole(
      ctx,
      rolesWriter,
      fenceFor(rolesWriter),
      'role-1',
      ['password', 'example'].join('='),
      apiCall,
    );
    expect(result).toEqual({ ok: false, error: 'invalid_name' });
    for (const store of [roles, grants, users]) {
      for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it.each(auditCases)('$method stages one audit event with its mutation', async (row) => {
    const stores = setup();
    expect(await row.run(stores.admin, apiCall)).toMatchObject({ ok: true });
    const input = storeInput(stores, row.store);
    expect(input.audit).toEqual({
      id: expect.stringMatching(/^ID\d+$/),
      occurredAt: NOW,
      action: row.action,
      actor: { type: 'user', id: administrator.userId },
      target: { type: row.type, id: row.id },
      projectId: null,
      sourceIp: null,
      tokenSelector: null,
      payloadJson: expect.any(String),
    });
    expect(JSON.parse(input.audit.payloadJson)).toEqual({
      op_id: apiCall.audit.opId,
      request_id: apiCall.audit.requestId,
      ...(row.changes === undefined ? {} : { changes: row.changes }),
    });
    expect(
      mutatingCalls(stores.grants, stores.roles).reduce((n, mock) => n + mock.mock.calls.length, 0),
    ).toBe(1);
  });

  it('excludes an email subject from the grant payload', async () => {
    const stores = setup();
    await auditCases[4].run(stores.admin, apiCall);
    const { audit } = storeInput(stores, 'createOrganization');
    expect(audit.payloadJson).not.toContain('@');
    expect(audit.payloadJson).not.toContain('someone@example.com');
  });

  it('excludes a group value from the grant payload', async () => {
    const stores = setup();
    await stores.admin.grantOrganization(
      ctx,
      administrator,
      fenceFor(administrator),
      { subject: { type: 'group', provider: 'corp', value: 'private-team' }, roleId: 'role-1' },
      apiCall,
    );
    const { audit } = storeInput(stores, 'createOrganization');
    expect(audit.payloadJson).not.toContain('private-team');
    expect(JSON.parse(audit.payloadJson).changes.subject_kind).toEqual({ new: 'group' });
  });

  it.each(['authority', 'conflict', 'indeterminate'] as const)(
    'preserves the store %s refusal without another mutation',
    async (answer) => {
      const stores = setup({ roles: { rename: vi.fn(async () => answer) } });
      expect(await auditCases[1].run(stores.admin, apiCall)).toEqual({
        ok: false,
        error: answer === 'authority' ? 'forbidden' : answer,
      });
      expect(storeInput(stores, 'rename').audit).toBeDefined();
      expect(
        mutatingCalls(stores.grants, stores.roles).reduce(
          (n, mock) => n + mock.mock.calls.length,
          0,
        ),
      ).toBe(1);
      expect(stores.log.mock.calls.some(([entry]) => entry.event === 'role.changed')).toBe(false);
    },
  );

  it.each(auditCases)('$method forwards the identical idempotency record', async (row) => {
    const stores = setup();
    const idempotency: IdempotencyRecord = {
      principalKey: 'user:admin-1',
      key: 'retry1',
      route: '/api/admin',
      requestHash: 'hash',
      status: 200,
      responseJson: '{}',
      createdAt: NOW,
      expiresAt: '2026-10-16T08:00:00.000Z',
    };
    await row.run(stores.admin, { ...apiCall, idempotency });
    expect(storeInput(stores, row.store).idempotency).toBe(idempotency);
  });

  it.each(auditCases)('$method omits an absent idempotency record', async (row) => {
    const stores = setup();
    await row.run(stores.admin, apiCall);
    expect(storeInput(stores, row.store)).not.toHaveProperty('idempotency');
  });

  it('requires the call argument at the type boundary', () => {
    const missingCall = () => {
      // @ts-expect-error ApiCall is required for every mutation.
      return setup().admin.deleteRole(ctx, administrator, fenceFor(administrator), 'role-1');
    };
    expect(missingCall).toBeTypeOf('function');
  });
});
