import { describe, expect, it, vi } from 'vitest';
import type { GrantRepository } from '../db/grants.js';
import { orgContext } from '../db/port.js';
import type { Role, RoleRepository } from '../db/roles.js';
import { fixedClock } from '../ids.js';
import type { IdentityProvider } from '../identity/port.js';
import { createAdministration } from './administration.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import type { ProjectActor } from './project-actor.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-15T08:00:00.000Z';
const ORG_PERMISSIONS = ['org:roles:write', 'org:grants:write', 'org:users:write'];

const roleOf = (id: string, permissions: string[]): Role => ({
  id,
  key: id,
  name: id,
  scope: 'organization',
  isSystem: false,
  protectsLastHolder: false,
  revision: 1,
  permissions,
});

function setup() {
  const roles = {
    list: vi.fn(async () => []),
    get: vi.fn(async (_ctx: unknown, id: string) => roleOf(id, ['org:read'])),
    create: vi.fn(async () => 'created'),
    rename: vi.fn(async () => 'renamed'),
    setPermissions: vi.fn(async () => 'updated'),
    delete: vi.fn(async () => 'deleted'),
  };
  const grants = {
    listOrganization: vi.fn(async () => []),
    createOrganization: vi.fn(async () => 'created'),
    deleteOrganization: vi.fn(async () => 'deleted'),
    changeRole: vi.fn(async () => 'updated'),
    suspendUser: vi.fn(async () => 'suspended'),
    reactivateUser: vi.fn(async () => 'reactivated'),
  };
  const log = vi.fn();
  const admin = createAdministration({
    roles: roles as unknown as RoleRepository,
    grants: grants as unknown as GrantRepository,
    users: { get: vi.fn(async () => ({ id: 'u1', email: 'target@example.com' }) as never) },
    providers: new Map<string, IdentityProvider>(),
    clock: fixedClock(NOW),
    ids: { ulid: () => 'ID00' },
    log,
  });
  return { admin, roles, grants, log };
}

const fenceFor = (actor: { userId: string }) =>
  mutationFence({ userId: actor.userId, sessionId: 's1' } as unknown as AuthenticatedActor, {
    role: 1,
    grant: 1,
  });

const writes = (s: ReturnType<typeof setup>) => [
  s.roles.create,
  s.roles.rename,
  s.roles.setPermissions,
  s.roles.delete,
  s.grants.createOrganization,
  s.grants.deleteOrganization,
  s.grants.changeRole,
  s.grants.suspendUser,
  s.grants.reactivateUser,
];

function everyMutation(s: ReturnType<typeof setup>, actor: ActorContext) {
  const { admin } = s;
  const fence = fenceFor(actor);
  return Promise.all([
    admin.createRole(ctx, actor, fence, {
      key: 'ops_two',
      name: 'Ops',
      scope: 'organization',
      permissions: [],
    }),
    admin.renameRole(ctx, actor, fence, 'r1', 'Name'),
    admin.setRolePermissions(ctx, actor, fence, 'r1', []),
    admin.deleteRole(ctx, actor, fence, 'r1'),
    admin.grantOrganization(ctx, actor, fence, {
      subject: { type: 'email', value: 'me@example.com' },
      roleId: 'r1',
    }),
    admin.revokeOrganizationGrant(ctx, actor, fence, 'g1'),
    admin.changeGrantRole(ctx, actor, fence, 'g1', 'r1'),
    admin.suspendUser(ctx, actor, fence, 'u1'),
    admin.reactivateUser(ctx, actor, fence, 'u1'),
  ]);
}

describe('only an organization-kind actor holds organization authority', () => {
  it('refuses a project-kind actor that injects every org permission and the admin flag', async () => {
    const s = setup();
    const injected = {
      kind: 'project',
      userId: 'actor-1',
      orgId: 'org-a',
      projectId: 'p1',
      permissions: new Set([...ORG_PERMISSIONS, 'org:*']),
      isOrganizationAdmin: true,
    } as unknown as ActorContext;
    for (const result of await everyMutation(s, injected)) {
      expect(result).toEqual({ ok: false, error: 'forbidden' });
    }
    for (const call of writes(s)) expect(call).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledTimes(9);
    for (const [entry] of s.log.mock.calls) {
      expect(entry).toMatchObject({ event: 'admin.denied', orgId: 'org-a', actorUserId: null });
    }
  });

  it('refuses an untagged actor holding org:roles:write and writes nothing', async () => {
    const s = setup();
    const untagged = {
      userId: 'actor-1',
      permissions: new Set(['org:roles:write']),
      isOrganizationAdmin: false,
    } as unknown as ActorContext;
    const result = await s.admin.createRole(ctx, untagged, fenceFor(untagged), {
      key: 'ops_two',
      name: 'Ops',
      scope: 'organization',
      permissions: [],
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    for (const call of writes(s)) expect(call).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'admin.denied',
      action: 'created',
      orgId: 'org-a',
      actorUserId: null,
    });
  });

  it('refuses an untagged actor holding only project-scope names on every mutator', async () => {
    const s = setup();
    const untagged = {
      userId: 'actor-1',
      permissions: new Set(['project:settings:write', 'project:read']),
      isOrganizationAdmin: false,
    } as unknown as ActorContext;
    for (const result of await everyMutation(s, untagged)) {
      expect(result).toEqual({ ok: false, error: 'forbidden' });
    }
    for (const call of writes(s)) expect(call).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledTimes(9);
  });

  it.each(['service', 'Organization', null, 7])('refuses kind %j', async (kind) => {
    const s = setup();
    const odd = {
      kind,
      userId: 'actor-1',
      permissions: new Set(ORG_PERMISSIONS),
      isOrganizationAdmin: true,
    } as unknown as ActorContext;
    for (const result of await everyMutation(s, odd)) {
      expect(result).toEqual({ ok: false, error: 'forbidden' });
    }
    for (const call of writes(s)) expect(call).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledTimes(9);
  });

  it('accepts an explicit organization-kind actor', async () => {
    const s = setup();
    const actor: ActorContext = {
      kind: 'organization',
      userId: 'actor-1',
      permissions: new Set(ORG_PERMISSIONS),
      isOrganizationAdmin: true,
    };
    expect(await s.admin.deleteRole(ctx, actor, fenceFor(actor), 'r1')).toEqual({
      ok: true,
      value: null,
    });
  });

  it('does not compile a ProjectActor as an ActorContext', () => {
    const project: ProjectActor = {
      kind: 'project',
      userId: 'actor-1',
      orgId: 'org-a' as ProjectActor['orgId'],
      projectId: 'p1',
      permissions: new Set(['org:roles:write']),
    };
    // @ts-expect-error a project actor never carries organization authority
    const asContext: ActorContext = { ...project, isOrganizationAdmin: false };
    expect(asContext.userId).toBe('actor-1');
  });
});

describe('isOrganizationAdmin is read once and must be exactly true', () => {
  it('a false string leaves delete and rename inside the subset rule', async () => {
    const s = setup();
    s.roles.get.mockResolvedValue(roleOf('r1', ['org:read', 'org:members:write']));
    const actor = {
      kind: 'organization',
      userId: 'actor-1',
      permissions: new Set(['org:roles:write', 'org:read']),
      isOrganizationAdmin: 'false',
    } as unknown as ActorContext;
    expect(await s.admin.deleteRole(ctx, actor, fenceFor(actor), 'r1')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await s.admin.renameRole(ctx, actor, fenceFor(actor), 'r1', 'Name')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(s.roles.delete).not.toHaveBeenCalled();
    expect(s.roles.rename).not.toHaveBeenCalled();
    expect(s.log.mock.calls.map(([entry]) => [entry.event, entry.action])).toEqual([
      ['admin.denied', 'deleted'],
      ['admin.denied', 'renamed'],
    ]);
  });

  it('a malformed actor is logged once with a null actor id', async () => {
    const s = setup();
    const bad = {
      userId: 'x@example.com',
      permissions: ['org:roles:write'],
    } as unknown as ActorContext;
    await s.admin.deleteRole(ctx, bad, fenceFor(bad), 'r1');
    expect(s.roles.delete).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'admin.denied',
      action: 'deleted',
      orgId: 'org-a',
      actorUserId: null,
    });
  });
});

describe('a project-scoped role never carries org:* permissions', () => {
  const actor: ActorContext = {
    kind: 'organization',
    userId: 'actor-1',
    permissions: new Set(['org:roles:write', 'org:read', 'org:grants:write']),
    isOrganizationAdmin: true,
  };

  it('createRole refuses an org permission in a project role', async () => {
    const s = setup();
    const result = await s.admin.createRole(ctx, actor, fenceFor(actor), {
      key: 'proj_ops',
      name: 'Ops',
      scope: 'project',
      permissions: ['org:read'],
    });
    expect(result).toMatchObject({ ok: false, error: 'invalid_permission' });
    expect(s.roles.create).not.toHaveBeenCalled();
  });

  it('setRolePermissions refuses an org permission on a stored project role', async () => {
    const s = setup();
    s.roles.get.mockResolvedValue({ ...roleOf('r1', []), scope: 'project' });
    const result = await s.admin.setRolePermissions(ctx, actor, fenceFor(actor), 'r1', [
      'org:roles:write',
    ]);
    expect(result).toMatchObject({ ok: false, error: 'invalid_permission' });
    expect(s.roles.setPermissions).not.toHaveBeenCalled();
  });
});
